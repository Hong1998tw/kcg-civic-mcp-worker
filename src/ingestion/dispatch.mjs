import { CollectorError, PROFILE_MANIFEST, parseCollectorArgs, runCollection } from './collector.mjs';
import { KCC_PROFILE_MANIFEST, runKccCollection, runKccEnrichmentV2 } from './kcc-collector.mjs';
import { OFFICIAL_PROFILES, runOfficialCollection } from './official-collection.mjs';

export const COLLECTION_PROFILES = Object.freeze({ ...PROFILE_MANIFEST, ...KCC_PROFILE_MANIFEST, ...OFFICIAL_PROFILES });
export const COLLECTION_DATASETS = Object.freeze(Object.fromEntries(Object.entries(COLLECTION_PROFILES).map(([profile, value]) => [profile, value.dataset])));

export function parseDispatchArgs(argv) {
  const profilePosition = argv.indexOf('--profile');
  const profile = argv[profilePosition + 1];
  if (!Object.hasOwn(COLLECTION_PROFILES, profile)) throw new CollectorError('PROFILE_NOT_ALLOWLISTED', 'profile 不在固定來源清單');
  if (Object.hasOwn(PROFILE_MANIFEST, profile)) return parseCollectorArgs(argv);
  const options = { profile, root: null, run: false, maxRequests: 25 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--run' || key === '--dry-run') { options.run = key === '--run'; continue; }
    if (!['--profile', '--root', '--max-requests'].includes(key)) throw new CollectorError('ARGUMENT_INVALID', '不支援的採集參數');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new CollectorError('ARGUMENT_INVALID', '採集參數缺少值');
    if (key === '--root') options.root = value;
    if (key === '--max-requests') {
      options.maxRequests = Number(value);
      if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 100) throw new CollectorError('ARGUMENT_INVALID', '每段最多100個官方請求');
    }
  }
  if (!options.root) throw new CollectorError('ROOT_REQUIRED', '必須指定本機資料根目錄');
  return options;
}

export async function runDispatchedCollection(options, dependencies = {}) {
  const { profile, root } = options;
  if (!Object.hasOwn(COLLECTION_PROFILES, profile)) throw new CollectorError('PROFILE_NOT_ALLOWLISTED', 'profile 不在固定來源清單');
  if (Object.hasOwn(PROFILE_MANIFEST, profile)) return runCollection(options, dependencies);
  if (!options.run) return { profile, dataset: COLLECTION_DATASETS[profile], status: 'pending', dry_run: true, commit_state: 'not-started', continuation_required: false };
  let result;
  if (Object.hasOwn(KCC_PROFILE_MANIFEST, profile)) {
    const input = { profile, root, maxRequests: options.maxRequests ?? 25, maxDurationMs: 75000 };
    result = ['kcc-proposal-details', 'kcc-meeting-records'].includes(profile)
      ? await runKccEnrichmentV2(input, dependencies)
      : await runKccCollection(input, dependencies);
  } else {
    result = await runOfficialCollection({ profile, root, maxRequests: options.maxRequests ?? 25, maxRecords: 50, maxPages: 100, resume: true, commit: true, downloadAttachments: true }, dependencies);
  }
  return { ...result, dry_run: false, basic_validation: result.error_code ? 'not-passed' : 'passed',
    human_semantic_validation: result.human_semantic_validation || 'pending',
    continuation_required: result.continuation_required === true };
}
