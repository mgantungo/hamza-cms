'use strict';

const { factories } = require('@strapi/strapi');

function toFrontendShape(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    status: entry.asset_status,
    department: entry.assigned_to?.department ?? null,
  };
}

async function resolveStaffRelation(strapi, staffId) {
  if (!staffId) return null;
  const matches = await strapi.documents('api::staff.staff').findMany({
    filters: { staff_id: staffId },
  });
  if (!matches.length) {
    throw new Error(`Staff ${staffId} not found`);
  }
  return matches[0].documentId;
}

async function resolveDocumentId(strapi, idParam) {
  if (/^\d+$/.test(String(idParam))) {
    const entry = await strapi.db.query('api::company-asset.company-asset').findOne({
      where: { id: idParam },
    });
    if (!entry) return null;
    return entry.documentId;
  }
  return idParam;
}

async function logAssetHistory(strapi, { actionType, assetDocumentId, previousAssignee, newAssignee, reason, notes, extra }) {
  try {
    await strapi.documents('api::asset-history.asset-history').create({
      data: {
        action_type: actionType,
        company_asset: assetDocumentId,
        previous_assignee: previousAssignee || null,
        new_assignee: newAssignee || null,
        reason: reason || null,
        notes: notes || null,
        extra: extra || {},
        event_date: new Date().toISOString(),
      },
    });
  } catch (err) {
    strapi.log.error('Failed to log asset history:', err);
  }
}

module.exports = factories.createCoreController('api::company-asset.company-asset', ({ strapi }) => ({
  async all(ctx) {
    const entries = await strapi.documents('api::company-asset.company-asset').findMany({
      populate: { assigned_to: true },
    });
    return { data: entries.map(toFrontendShape) };
  },

  async lookup(ctx) {
    const { identifier } = ctx.params;
    const entries = await strapi.documents('api::company-asset.company-asset').findMany({
      filters: { tag_number: identifier },
      populate: { assigned_to: true },
    });
    if (!entries.length) return ctx.notFound('Asset not found');
    return toFrontendShape(entries[0]);
  },

  async find(ctx) {
    ctx.query = { ...ctx.query, populate: { assigned_to: true, ...(ctx.query.populate || {}) } };
    const { data, meta } = await super.find(ctx);
    return { data: data.map(toFrontendShape), meta };
  },

  async findOne(ctx) {
    ctx.query = { ...ctx.query, populate: { assigned_to: true, ...(ctx.query.populate || {}) } };
    const result = await super.findOne(ctx);
    if (result?.data) result.data = toFrontendShape(result.data);
    return result;
  },

  async update(ctx) {
    const resolvedId = await resolveDocumentId(strapi, ctx.params.id);
    if (!resolvedId) return ctx.notFound('Asset not found');
    ctx.params.id = resolvedId;

    const body = ctx.request.body.data || ctx.request.body || {};

    const before = await strapi.documents('api::company-asset.company-asset').findOne({
      documentId: resolvedId,
      populate: { assigned_to: true },
    });
    const previousStaffId = before?.assigned_to?.staff_id || null;

    if (body.status !== undefined) {
      body.asset_status = body.status;
      delete body.status;
    }

    if (body.asset_status === 'lost' || body.asset_status === 'decommissioned') {
      body.assigned_to = null;
    }

    if (body.assigned_to !== undefined && body.assigned_to !== null) {
      if (before?.asset_status === 'lost' || before?.asset_status === 'decommissioned') {
        return ctx.badRequest(`Cannot assign asset — it is currently marked ${before.asset_status}`);
      }
    }

    let newStaffId = null;
    if (body.assigned_to !== undefined) {
      if (body.assigned_to === null) {
        body.assigned_to = null;
      } else {
        newStaffId = body.assigned_to;
        body.assigned_to = await resolveStaffRelation(strapi, body.assigned_to);
      }
    }

    const reason = body.reason;
    const notes = body.notes;
    const extra = body.extra;
    delete body.reason;
    delete body.extra;
    delete body.department;

    if (extra?.dateLost) {
      const lostDate = new Date(extra.dateLost);
      if (lostDate > new Date()) {
        return ctx.badRequest('Lost date cannot be in the future');
      }
    }

    ctx.request.body.data = body;
    const result = await super.update(ctx);
    if (result?.data) result.data = toFrontendShape(result.data);

    try {
      let actionType = null;
      if (body.asset_status === 'lost') actionType = 'lost';
      else if (body.asset_status === 'decommissioned') actionType = 'decommission';
      else if (body.assigned_to === null && previousStaffId) actionType = 'unassign';
      else if (newStaffId && previousStaffId && newStaffId !== previousStaffId) actionType = 'reassign';
      else if (newStaffId && !previousStaffId) actionType = 'assign';

      if (actionType) {
        await logAssetHistory(strapi, {
          actionType,
          assetDocumentId: resolvedId,
          previousAssignee: previousStaffId,
          newAssignee: newStaffId,
          reason,
          notes,
          extra,
        });
      }
    } catch (err) {
      strapi.log.error('Asset history logging failed:', err);
    }

    return result;
  },
}));