import type { PlatformService } from './base'
import { HuaweiService } from './huawei'
import { HonorService } from './honor'
import { XiaomiService } from './xiaomi'
import { OppoService } from './oppo'
import { VivoService } from './vivo'
import { YingyongbaoService } from './yingyongbao'

export type PlatformId = 'huawei' | 'honor' | 'xiaomi' | 'oppo' | 'vivo' | 'yingyongbao'

const registry: Record<PlatformId, PlatformService> = {
  huawei: new HuaweiService(),
  honor: new HonorService(),
  xiaomi: new XiaomiService(),
  oppo: new OppoService(),
  vivo: new VivoService(),
  yingyongbao: new YingyongbaoService()
}

export function getService(platform: string): PlatformService {
  const svc = registry[platform as PlatformId]
  if (!svc) throw new Error(`Unknown platform: ${platform}`)
  return svc
}

export function getAllServices(): PlatformService[] {
  return Object.values(registry)
}

export { PlatformNoPollingError, PlatformApiError } from './base'
export type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
