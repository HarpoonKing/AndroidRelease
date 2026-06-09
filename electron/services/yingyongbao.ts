import axios from 'axios'
import { basename } from 'path'
import { createHash, createHmac } from 'crypto'
import { readFileSync } from 'fs'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * 腾讯应用宝 Open API（开发者API）
 * Auth: user_id + access_secret + HmacSHA256(sign)
 */

const YYB_BASE_URL = 'https://p.open.qq.com/open_file/developer_api'
const YYB_GET_UPLOAD_INFO_URL = `${YYB_BASE_URL}/get_file_upload_info`
const YYB_UPDATE_URL = `${YYB_BASE_URL}/update_app`
const YYB_AUDIT_STATUS_URL = `${YYB_BASE_URL}/query_app_update_status`
const GET_UPLOAD_INFO_TIMEOUT_MS = 30_000
const UPLOAD_FILE_TIMEOUT_MS = 15 * 60_000
const UPDATE_APP_TIMEOUT_MS = 2 * 60_000
const AUDIT_STATUS_TIMEOUT_MS = 15_000

type ApiResponse = {
  ret: number
  msg: string
}

function normalizeCreds(creds: Record<string, string>): {
  userId: string
  accessSecret: string
  appId: string
  pkgName: string
} {
  return {
    userId: (creds.userId || creds.devId || '').trim(),
    accessSecret: (creds.accessSecret || creds.devKey || '').trim(),
    appId: (creds.appId || '').trim(),
    pkgName: (creds.pkgName || creds.bundleId || '').trim()
  }
}

function assertRequiredCreds(creds: Record<string, string>): void {
  const c = normalizeCreds(creds)
  const missing: string[] = []
  if (!c.userId) missing.push('user_id')
  if (!c.accessSecret) missing.push('access_secret')
  if (!c.appId) missing.push('app_id')
  if (!c.pkgName) missing.push('pkg_name')
  if (missing.length > 0) {
    throw new PlatformApiError('yingyongbao', 'MISSING_CREDENTIALS', `缺少必填凭证: ${missing.join(', ')}`)
  }
}

function buildSign(params: Record<string, string>, accessSecret: string): string {
  const signContent = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')

  return createHmac('sha256', accessSecret).update(signContent).digest('hex')
}

function withCommonParams(
  businessParams: Record<string, string>,
  creds: Record<string, string>
): Record<string, string> {
  const normalized = normalizeCreds(creds)
  const params: Record<string, string> = {
    user_id: normalized.userId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...businessParams
  }

  params.sign = buildSign(params, normalized.accessSecret)
  return params
}

function toUrlencoded(params: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      form.append(k, v)
    }
  }
  return form
}

function isTimeoutError(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message))
}

function redactBody(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text
}

function describeAxiosError(stage: string, err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return `${stage}失败: ${err instanceof Error ? err.message : String(err)}`
  }

  const method = (err.config?.method || 'GET').toUpperCase()
  const url = `${err.config?.baseURL ?? ''}${err.config?.url ?? ''}` || 'unknown-url'
  const status = err.response?.status ?? 'N/A'
  const parts = [
    `${stage}失败`,
    `HTTP ${status} ${method} ${url}`
  ]

  if (err.code) parts.push(`Axios code=${err.code}`)
  if (err.message) parts.push(`Axios message=${err.message}`)

  const responseData = err.response?.data
  if (responseData !== undefined) {
    const body = typeof responseData === 'string' ? responseData : JSON.stringify(responseData)
    parts.push(`Response=${redactBody(body)}`)
  }

  const requestData = (err.config as { data?: unknown } | undefined)?.data
  if (requestData !== undefined) {
    const body = typeof requestData === 'string' ? requestData : JSON.stringify(requestData)
    parts.push(`Request=${redactBody(body)}`)
  }

  return parts.join(' | ')
}

function stageError(stage: string, err: unknown): never {
  if (isTimeoutError(err)) {
    throw new PlatformApiError('yingyongbao', 'TIMEOUT', `${stage}超时，请重试或调大超时时间`)
  }
  if (axios.isAxiosError(err)) {
    throw new PlatformApiError('yingyongbao', `HTTP_${err.response?.status ?? 'N/A'}`, describeAxiosError(stage, err))
  }
  throw new PlatformApiError('yingyongbao', 'STAGE_FAILED', describeAxiosError(stage, err))
}

export class YingyongbaoService implements PlatformService {
  readonly platform = 'yingyongbao'
  readonly displayName = '腾讯应用宝'

  getCredentialSchema(): CredentialField[] {
    return [
      {
        key: 'userId',
        label: 'User ID',
        type: 'text',
        required: true,
        placeholder: '开放平台分配的 user_id'
      },
      {
        key: 'accessSecret',
        label: 'Access Secret',
        type: 'password',
        required: true,
        placeholder: '开放平台申请的 access_secret'
      },
      {
        key: 'appId',
        label: 'App ID',
        type: 'text',
        required: true,
        placeholder: '应用 ID'
      },
      {
        key: 'pkgName',
        label: 'Package Name',
        type: 'text',
        required: true,
        placeholder: '应用包名，如 com.example.app'
      }
    ]
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    assertRequiredCreds(creds)
    const normalized = normalizeCreds(creds)
    const startedAt = Date.now()

    const logStage = (message: string): void => {
      // eslint-disable-next-line no-console
      console.log(`[Yingyongbao] ${message}`)
    }

    logStage(`开始上传任务 appId=${normalized.appId} pkg=${normalized.pkgName} apk=${apkPath}`)
    const uploadInfoParams = withCommonParams(
      {
        pkg_name: normalized.pkgName,
        app_id: normalized.appId,
        file_type: 'apk',
        file_name: basename(apkPath)
      },
      creds
    )

    const uploadInfoStart = Date.now()
    const uploadInfoRes = await axios.post<
      ApiResponse & {
        pre_sign_url?: string
        serial_number?: string
      }
    >(YYB_GET_UPLOAD_INFO_URL, toUrlencoded(uploadInfoParams), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: GET_UPLOAD_INFO_TIMEOUT_MS
    }).catch((err) => stageError('获取应用宝文件上传信息', err))
    logStage(`获取上传信息完成，耗时 ${Date.now() - uploadInfoStart}ms`)

    if (uploadInfoRes.data.ret !== 0 || !uploadInfoRes.data.pre_sign_url || !uploadInfoRes.data.serial_number) {
      throw new PlatformApiError(
        'yingyongbao',
        uploadInfoRes.data.ret ?? 'upload_info_error',
        uploadInfoRes.data.msg ?? 'Failed to get upload info'
      )
    }

    // 文档要求上传原始文件字节到预签名URL。
    const apkBuffer = readFileSync(apkPath)
    const fileName = basename(apkPath)
    const uploadStart = Date.now()
    logStage(`开始上传APK到COS file=${fileName} size=${apkBuffer.length} bytes`)
    await axios.put(uploadInfoRes.data.pre_sign_url, apkBuffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: UPLOAD_FILE_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }).catch((err) => stageError('上传应用宝APK到COS', err))
    logStage(`APK上传到COS完成，耗时 ${Date.now() - uploadStart}ms`)

    const apkMd5 = createHash('md5').update(apkBuffer).digest('hex')

    const updateStart = Date.now()
    logStage(`开始提交应用更新，serial=${uploadInfoRes.data.serial_number}`)
    const updateParams = withCommonParams(
      {
        pkg_name: normalized.pkgName,
        app_id: normalized.appId,
        deploy_type: '1',
        apk32_flag: '1',
        apk32_file_serial_number: uploadInfoRes.data.serial_number,
        apk32_file_md5: apkMd5,
        feature: meta.releaseNotes || `版本更新 ${meta.versionName}(${meta.versionCode})`
      },
      creds
    )

    const updateRes = await axios.post<ApiResponse>(YYB_UPDATE_URL, toUrlencoded(updateParams), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: UPDATE_APP_TIMEOUT_MS
    }).catch((err) => stageError('提交应用宝更新', err))
    logStage(`提交应用更新完成，耗时 ${Date.now() - updateStart}ms`)

    if (updateRes.data.ret !== 0) {
      throw new PlatformApiError('yingyongbao', updateRes.data.ret, updateRes.data.msg)
    }

    logStage(`应用宝上传任务成功，总耗时 ${Date.now() - startedAt}ms`)
    return normalized.appId
  }

  async getAuditStatus(_auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    assertRequiredCreds(creds)
    const normalized = normalizeCreds(creds)

    const statusParams = withCommonParams(
      {
        pkg_name: normalized.pkgName,
        app_id: normalized.appId
      },
      creds
    )

    const res = await axios.post<
      ApiResponse & {
        audit_status?: number
      }
    >(YYB_AUDIT_STATUS_URL, toUrlencoded(statusParams), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: AUDIT_STATUS_TIMEOUT_MS
    }).catch((err) => stageError('查询应用宝审核状态', err))

    if (res.data.ret !== 0) {
      throw new PlatformApiError('yingyongbao', res.data.ret, res.data.msg)
    }

    switch (res.data.audit_status) {
      case 1:
        return 'pending'
      case 3:
        return 'passed'
      case 2:
      case 8:
      default:
        return 'failed'
    }
  }

  async publish(_auditTaskId: string, _creds: Record<string, string>): Promise<void> {
    // update_app 已包含提审/发布策略，本流程不需要额外发布接口。
    return
  }
}
