// Checks that Claude Code runs and the token works, without Telegram or state:
// scores one sample job and prints the result. Run from Actions with mode=selftest.
import { scoreJobs } from './claude.js';
import { makeJob } from './job.js';

const sample = makeJob({
  source: 'freelancer', id: 'selftest', title: 'Fix a slow Angular dashboard backed by an ASP.NET Core API',
  description: 'Our Angular 17 admin dashboard takes 8 seconds to load the sales report from our .NET 8 API with EF Core and PostgreSQL. Find the cause and fix it. Budget $150.',
  budgetType: 'fixed', budgetMinUsd: 100, budgetMaxUsd: 150, bidCount: 4,
});

const [scored] = await scoreJobs([sample], { draftMin: 7 });
if (!scored) throw new Error('Claude returned no score for the sample job');
console.log(`selftest ok: score ${scored.score}/10, reason "${scored.reasonVi}", proposal ${scored.proposalEn ? `${scored.proposalEn.length} chars` : 'none'}`);
