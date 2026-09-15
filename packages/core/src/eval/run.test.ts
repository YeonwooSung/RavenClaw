import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { runEvalDir } from './run'

test('pending-ask-persist fails if applyAskAnswer is missing', async () => {
  await expect(
    runEvalDir(join(import.meta.dir, 'fixtures')),
  ).resolves.toBeUndefined()
})
