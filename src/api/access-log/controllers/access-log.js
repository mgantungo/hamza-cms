'use strict';

const { factories } = require('@strapi/strapi');

async function resolveStaffEntry(strapi, value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    return await strapi.db.query('api::staff.staff').findOne({ where: { id: value } });
  }

  const matches = await strapi.documents('api::staff.staff').findMany({
    filters: { staff_id: value },
  });
  return matches.length ? matches[0] : null;
}

function startOfDayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function logAnomaly(strapi, { type, severity, description, location, assignedTo, details }) {
  try {
    await strapi.documents('api::anomaly.anomaly').create({
      data: {
        type,
        severity,
        description,
        location: location || null,
        assigned_to: assignedTo || null,
        details: details || {},
        reviewed: false,
        investigationStatus: 'not_started',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    strapi.log.error('Failed to create anomaly record:', err);
  }
}

module.exports = factories.createCoreController('api::access-log.access-log', ({ strapi }) => ({
  async today(ctx) {
    const { location } = ctx.params;
    const entries = await strapi.documents('api::access-log.access-log').findMany({
      filters: {
        location,
        timestamp: { $gte: startOfDayISO() },
      },
      populate: { staff: true },
      sort: { timestamp: 'desc' },
    });
    return { data: entries };
  },

  async allWithRelations(ctx) {
    const entries = await strapi.documents('api::access-log.access-log').findMany({
      populate: { staff: true },
      sort: { timestamp: 'desc' },
    });
    return { data: entries };
  },

  async create(ctx) {
    const body = ctx.request.body.data || ctx.request.body || {};

    let staffEntry = null;
    if (body.staff !== undefined) {
      staffEntry = await resolveStaffEntry(strapi, body.staff);
      body.staff = staffEntry ? staffEntry.documentId : null;
    }
    const staffLabel = staffEntry
      ? `${staffEntry.staff_name} (${staffEntry.staff_id})`
      : (body.card_id ? `Unrecognized card ${body.card_id}` : 'Unknown');

    let flagged = !staffEntry;
    const anomaliesToLog = [];

    let lastAction = null;
    if (body.card_id) {
      const lastLog = await strapi.db.query('api::access-log.access-log').findMany({
        where: { card_id: body.card_id },
        orderBy: { timestamp: 'desc' },
        limit: 1,
      });
      lastAction = lastLog.length ? lastLog[0].action : null;
    }

    if (body.action === 'Check out' && lastAction !== 'Check in') {
      flagged = true;
      anomaliesToLog.push({
        type: 'Movement Anomaly',
        severity: 'warning',
        description: `${staffLabel} exited at ${body.location || 'unknown location'} with no recorded check-in`,
        location: body.location,
        assignedTo: staffLabel,
        details: { card_id: body.card_id, action: body.action },
      });
    }

    if (body.action === 'Check in' && lastAction === 'Check in') {
      flagged = true;
      anomaliesToLog.push({
        type: 'Movement Anomaly',
        severity: 'warning',
        description: `${staffLabel} checked in at ${body.location || 'unknown location'} without checking out previously`,
        location: body.location,
        assignedTo: staffLabel,
        details: { card_id: body.card_id, action: body.action },
      });
    }

    if (Array.isArray(body.devices) && body.devices.length) {
      for (const tag of body.devices) {
        const assets = await strapi.documents('api::company-asset.company-asset').findMany({
          filters: { tag_number: tag },
          populate: { assigned_to: true },
        });
        if (!assets.length) continue;
        const asset = assets[0];
        const actionWord = body.action === 'Check out' ? 'exit with' : 'enter with';

        if (asset.asset_status === 'decommissioned') {
          flagged = true;
          anomaliesToLog.push({
            type: 'Status Anomaly',
            severity: 'critical',
            description: `${staffLabel} attempted to ${actionWord} decommissioned asset ${tag}`,
            location: body.location,
            assignedTo: staffLabel,
            details: { asset_tag: tag, asset_status: asset.asset_status, action: body.action },
          });
        } else if (asset.asset_status === 'lost') {
          flagged = true;
          anomaliesToLog.push({
            type: 'Status Anomaly',
            severity: 'critical',
            description: `${staffLabel} attempted to ${actionWord} asset ${tag}, which is marked lost/stolen`,
            location: body.location,
            assignedTo: staffLabel,
            details: { asset_tag: tag, asset_status: asset.asset_status, action: body.action },
          });
        }

        if (asset.assigned_to && staffEntry && asset.assigned_to.staff_id !== staffEntry.staff_id) {
          flagged = true;
          anomaliesToLog.push({
            type: 'Assignment Anomaly',
            severity: 'warning',
            description: `Asset ${tag} used by ${staffLabel} (${body.action}), but is assigned to ${asset.assigned_to.staff_name} (${asset.assigned_to.staff_id})`,
            location: body.location,
            assignedTo: staffLabel,
            details: { asset_tag: tag, assigned_to: asset.assigned_to.staff_id, used_by: staffEntry.staff_id, action: body.action },
          });
        }
      }
    }

    // Set flagged BEFORE creating, so it's correct from the very first write
    body.flagged = flagged;
    ctx.request.body.data = body;
    const result = await super.create(ctx);

    // Now log anomaly records (doesn't affect the access-log record itself anymore)
    for (const anomalyData of anomaliesToLog) {
      await logAnomaly(strapi, anomalyData);
    }

    return result;
  },

}));