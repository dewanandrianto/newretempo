import base from '../../../worker/vitest.config'
export default { ...base, test: { ...base.test, include: ['docs/phase-5-evidence/final-review-probes/password-reset-race.test.ts'] } }
