export type AuditStatus = 'pending' | 'passed' | 'failed'

export interface UploadMeta {
  versionName: string
  versionCode: number
  releaseNotes?: string
}

export interface CredentialField {
  key: string
  label: string
  type: 'text' | 'password'
  placeholder?: string
  required: boolean
}

/**
 * Each platform must implement this interface.
 * Credentials are passed as a plain object (already decrypted by the caller).
 */
export interface PlatformService {
  readonly platform: string
  readonly displayName: string

  /** Return the fields needed for this platform's credentials form */
  getCredentialSchema(): CredentialField[]

  /** Upload APK and return the platform-specific audit/task ID */
  upload(apkPath: string, meta: UploadMeta, credentials: Record<string, string>): Promise<string>

  /**
   * Poll audit status.
   * Some platforms (yingyongbao) don't support API polling — they should throw
   * a PlatformNoPollingError to indicate manual confirmation is required.
   */
  getAuditStatus(auditTaskId: string, credentials: Record<string, string>): Promise<AuditStatus>

  /** Trigger publish (put the approved version online) */
  publish(auditTaskId: string, credentials: Record<string, string>): Promise<void>

  /**
   * Optional: verify that credentials are valid (e.g. auth token exchange).
   * If not implemented, the platform does not support automated verification.
   */
  verify?(credentials: Record<string, string>): Promise<void>
}

export class PlatformNoPollingError extends Error {
  constructor(platform: string) {
    super(`Platform ${platform} does not support audit status polling. Manual confirmation required.`)
    this.name = 'PlatformNoPollingError'
  }
}

export class PlatformApiError extends Error {
  constructor(
    platform: string,
    public readonly code: string | number,
    message: string
  ) {
    super(`[${platform}] API Error ${code}: ${message}`)
    this.name = 'PlatformApiError'
  }
}
