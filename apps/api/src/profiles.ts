import { config } from './config.js';

export interface Profile {
  id: string;
  label: string;
  engine: 'redroid' | 'emulator';
  image: string | undefined;
  /** Ships Google Play services (enables Google health checks in the UI). */
  gapps: boolean;
  /** Host requirement checked at runtime. */
  requiresKvm: boolean;
  /** Known blocker on the current hosts; profile is shown but cannot be used. */
  blockedReason?: string;
  /** Planning estimate used by the create-time capacity check (measured: AOSP ~0.6, GApps 0.8–1.1 GiB). */
  memEstimateMb: number;
}

/** Image catalog. Instances keep their profile id; images are resolved at create time. */
export const PROFILES: Profile[] = [
  { id: 'redroid-12', label: 'Redroid 12（AOSP，无 Google 服务）', engine: 'redroid', image: config.REDROID_IMAGE, gapps: false, requiresKvm: false, memEstimateMb: 700 },
  { id: 'redroid-13-gapps', label: 'Redroid 13 + MindTheGapps（Google 服务）', engine: 'redroid', image: config.REDROID_GAPPS_IMAGE, gapps: true, requiresKvm: false, memEstimateMb: 1100 },
  { id: 'redroid-16-gapps', label: 'Redroid 16 + MindTheGapps（Google 服务）', engine: 'redroid', image: config.REDROID16_GAPPS_IMAGE, gapps: true, requiresKvm: false, memEstimateMb: 1400,
    blockedReason: '宿主内核缺少 ashmem：redroid 16 的图形分配器依赖 ashmem，Linux 5.18+ 已移除（见 docs/06-android-upgrade-plan.md）' },
  { id: 'emulator-playstore', label: 'Google Emulator（Play Store 镜像，需 x86_64 + KVM）', engine: 'emulator', image: config.EMULATOR_IMAGE, gapps: true, requiresKvm: true, memEstimateMb: 3072 },
];

export function getProfile(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
