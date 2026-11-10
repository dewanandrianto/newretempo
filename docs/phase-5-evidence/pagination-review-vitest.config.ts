import config from '../../chain-worker/vitest.config';
export default { ...config, test: { ...config.test, include: ['docs/phase-5-evidence/pagination-review-repro.test.ts'] } };
