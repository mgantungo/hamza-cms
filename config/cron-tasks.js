'use strict';
/** Nightly jobs. Times are server-local; set TZ=Africa/Kampala (or yours) in the environment. */
module.exports = {
  closeOfDay: {
    task: async () => {
      const ctx = { state: { appUser: { username: 'system' } }, request: { body: {} } };
      await require('../src/v2/handlers/reception').closeDay(ctx);
      // overdue loans older than 14 days → one case per loan
      const L = require('../src/v2/lib');
      const cutoff = new Date(Date.now() - Number(L.env('OVERDUE_CASE_DAYS', 14)) * 864e5).toISOString().slice(0, 10);
      const loans = await L.db(L.U.tx).find({ where: { type: 'lend', loan_status: 'open', due_date: { $lt: cutoff } }, populate: { item: true, taker: true, store: { populate: { branch: true } } } });
      for (const t of loans) {
        const ex = await L.db(L.U.case).one({ where: { type: 'overdue_loan', title: { $contains: `#${t.id}` } } });
        if (!ex) await L.openCase(ctx, { type: 'overdue_loan', severity: 'low', title: `Loan #${t.id} overdue: ${t.item?.name} with ${t.taker?.staff_name}`, staff: t.taker?.id || null, branch: t.store?.branch?.id || null });
      }
    },
    options: { rule: process.env.CLOSE_OF_DAY_CRON || '0 20 * * *' },
  },
};
