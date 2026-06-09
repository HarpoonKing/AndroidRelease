import axios from 'axios'
import FormData from 'form-data'
import { createReadStream } from 'fs'
import * as crypto from 'crypto'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * Vivo 开发者平台 Open API
 * Docs: https://dev.vivo.com.cn/documentCenter/doc/326
 * Auth: access_key + secret_key → HMAC-SHA256 签名
 * Note: 需要在后台手动申请 "API 传包" 权限
 *
 * 发布流程: app.upload.apk.app(上传APK) → app.sync.update.app(提交更新,onlineType=1审核后自动上架)
 * 审核查询: app.query.details 读 data.status
 */

const VIVO_BASE = 'https://developer-api.vivo.com.cn/router/rest'
const META_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000

/** 计算文件 MD5（流式，避免大文件占内存） */
function fileMd5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 构造带公共参数与 HMAC-SHA256 签名的完整参数集 */
function buildSignedParams(
  method: string,
  bizParams: Record<string, string>,
  creds: Record<string, string>
): Record<string, string> {
  const params: Record<string, string> = {
    method,
    access_key: creds.accessKey,
    timestamp: String(Date.now()),
    format: 'json',
    v: '1.0',
    sign_method: 'HMAC-SHA256',
    target_app_key: 'developer',
    ...bizParams
  }
  const signStr = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  params.sign = crypto.createHmac('sha256', creds.secretKey).update(signStr).digest('hex')
  return params
}

interface VivoResponse<T> {
  code: number
  subCode?: string
  msg?: string
  message?: string
  data?: T
}

/** 校验 vivo 响应：code=0 且 subCode 为空/“0” 才是成功 */
function checkVivo(resp: VivoResponse<unknown>): void {
  const subCode = resp?.subCode
  if (resp?.code !== 0 || (subCode && subCode !== '0')) {
    throw new PlatformApiError(
      'vivo',
      subCode && subCode !== '0' ? subCode : resp?.code,
      resp?.msg || resp?.message || '请求失败'
    )
  }
}

export class VivoService implements PlatformService {
  readonly platform = 'vivo'
  readonly displayName = 'Vivo 应用商店'

  getCredentialSchema(): CredentialField[] {
    return [
      {
        key: 'accessKey',
        label: 'Access Key',
        type: 'text',
        required: true,
        placeholder: 'Vivo 开放平台 Access Key'
      },
      {
        key: 'secretKey',
        label: 'Secret Key',
        type: 'password',
        required: true,
        placeholder: 'Vivo 开放平台 Secret Key'
      },
      {
        key: 'packageName',
        label: '包名 (Package Name)',
        type: 'text',
        required: true,
        placeholder: 'com.example.app'
      }
    ]
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const md5 = await fileMd5(apkPath)

    // Step 1: 上传 APK（签名参数放查询串，文件放 multipart body）
    const uploadParams = buildSignedParams(
      'app.upload.apk.app',
      { packageName: creds.packageName, fileMd5: md5 },
      creds
    )
    const form = new FormData()
    form.append('file', createReadStream(apkPath))

    const uploadRes = await axios.post<
      VivoResponse<{ serialnumber: string; packageName: string; versionCode: string; fileMd5: string }>
    >(VIVO_BASE, form, {
      params: uploadParams,
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    checkVivo(uploadRes.data)
    const serialno = uploadRes.data.data?.serialnumber
    if (!serialno) {
      throw new PlatformApiError('vivo', uploadRes.data.code, '上传未返回流水号')
    }

    // Step 2: 提交更新（onlineType=1 审核通过后自动上架）
    // updateDesc 要求 5~200 个字符，为空或过短时用默认文案
    const notes = (meta.releaseNotes ?? '').trim()
    const updateDesc = notes.length >= 5 ? notes.slice(0, 200) : '应用版本更新优化'
    const submitParams = buildSignedParams(
      'app.sync.update.app',
      {
        packageName: creds.packageName,
        versionCode: String(meta.versionCode),
        apk: serialno,
        fileMd5: md5,
        onlineType: '1',
        updateDesc
      },
      creds
    )
    const submitRes = await axios.post<VivoResponse<unknown>>(VIVO_BASE, null, {
      params: submitParams,
      timeout: META_TIMEOUT_MS
    })
    checkVivo(submitRes.data)

    // vivo 按包名查询审核状态，返回 packageName 作为审核任务 ID
    return creds.packageName
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const params = buildSignedParams('app.query.details', { packageName: auditTaskId }, creds)
    const res = await axios.post<VivoResponse<{ status?: number }>>(VIVO_BASE, null, {
      params,
      timeout: META_TIMEOUT_MS
    })
    checkVivo(res.data)

    // status: 1=草稿,2=待审核,3=审核通过,4=审核不通过,5=撤销审核
    const status = res.data.data?.status
    if (status === 3) return 'passed'
    if (status === 4) return 'failed'
    return 'pending'
  }

  async publish(): Promise<void> {
    // vivo 提交时已用 onlineType=1（审核通过后自动上架），无需单独发布接口
  }

  async verify(creds: Record<string, string>): Promise<void> {
    // 通过查询接口验证签名与权限（需包名，错误签名会报 10018）
    const params = buildSignedParams('app.query.details', { packageName: creds.packageName }, creds)
    const res = await axios.post<VivoResponse<unknown>>(VIVO_BASE, null, {
      params,
      timeout: META_TIMEOUT_MS
    })
    checkVivo(res.data)
  }
}
