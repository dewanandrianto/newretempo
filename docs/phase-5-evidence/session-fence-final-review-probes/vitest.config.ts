import base from '../../../worker/vitest.config'
export default { ...base, test: { ...base.test, include: ['docs/phase-5-evidence/session-fence-final-review-probes/*.test.ts'] } }
