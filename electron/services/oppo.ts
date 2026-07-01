import axios from 'axios'
import { execFile } from 'child_process'
import FormData from 'form-data'
import { nativeImage } from 'electron'
import { createReadStream } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import * as crypto from 'crypto'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * OPPO 开放平台 Open API
 * Docs: https://open.oppomobile.com/new/developmentDoc/info?id=10998
 *
 * Auth: GET /developer/v1/token?client_id&client_secret → access_token（无需签名）
 * 资源接口（/resource/v1/...）需对参数签名：
 *   追加 access_token + timestamp(秒) → 参数名 ASCII 升序拼成 k=v&k=v
 *   → HMAC-SHA256(clientSecret) hex → api_sign
 *
 * 发布流程: queryApp(获取应用元数据) → uploadAPK → app/upd(提交版本) → app/task-state(轮询)
 */

const OPPO_DOMAIN = 'https://oop-openapi-cn.heytapmobi.com'
const TOKEN_TIMEOUT_MS = 15_000
const META_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000

// 发布时的非失败错误码
const OPPO_TASK_IN_FLIGHT = 911216 // 版本更新任务处理中
const OPPO_UNDER_REVIEW = 911215 // 应用审核中（已进入审核队列）
const OPPO_ICON_SIZE = 512
const OPPO_SCREENSHOT_WIDTH = 1080 // Android 标准截图宽度
const OPPO_SCREENSHOT_HEIGHT = 1920 // Android 标准截图高度（9:16 比例）
const execFileAsync = promisify(execFile)

interface OppoToken {
  access_token: string
  expire_time: number // Unix timestamp ms
}

interface OppoAppData {
  app_name?: string
  second_category_id?: string
  third_category_id?: string
  summary?: string
  detail_desc?: string
  privacy_source_url?: string
  icon_url?: string
  pic_url?: string
  copyright_url?: string
  business_username?: string
  business_email?: string
  business_mobile?: string
  age_level?: string
  adaptive_equipment?: string
  customer_contact?: string
}

const tokenCache = new Map<string, OppoToken>()

/** 从 OPPO 响应中提取可读错误信息（消息位置不固定） */
function parseOppoError(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const candidates = [
      d.message,
      d.msg,
      (d.data as Record<string, unknown> | undefined)?.message,
      (d.data as Record<string, unknown> | undefined)?.msg
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c
    }
  }
  return 'Unknown OPPO API error'
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId)
  if (cached && Date.now() < cached.expire_time - 60_000) {
    return cached.access_token
  }

  const res = await axios.get<{
    errno: number
    data?: { access_token?: string; expire_in?: number }
  }>(`${OPPO_DOMAIN}/developer/v1/token`, {
    params: { client_id: clientId, client_secret: clientSecret },
    timeout: TOKEN_TIMEOUT_MS
  })

  if (res.data?.errno !== 0 || !res.data.data?.access_token) {
    throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
  }

  const expireInSec = res.data.data.expire_in ?? 23 * 3600
  const token: OppoToken = {
    access_token: res.data.data.access_token,
    expire_time: Date.now() + expireInSec * 1000
  }
  tokenCache.set(clientId, token)
  return token.access_token
}

/** 追加公共参数并计算 api_sign 签名 */
function signParams(
  params: Record<string, string>,
  accessToken: string,
  clientSecret: string
): Record<string, string> {
  const signed: Record<string, string> = {
    ...params,
    access_token: accessToken,
    timestamp: Math.floor(Date.now() / 1000).toString()
  }
  const signStr = Object.keys(signed)
    .sort()
    .map((k) => `${k}=${signed[k]}`)
    .join('&')
  signed.api_sign = crypto.createHmac('sha256', clientSecret).update(signStr).digest('hex')
  return signed
}

async function convertImageToPng(
  imageBuffer: Buffer,
  imageUrl: string,
  size?: { width: number; height: number }
): Promise<Buffer> {
  const image = nativeImage.createFromBuffer(imageBuffer)
  if (!image.isEmpty()) {
    const normalizedImage = size ? image.resize({ width: size.width, height: size.height, quality: 'best' }) : image
    return normalizedImage.toPNG()
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'oppo-image-'))
  const inputPath = join(tempDir, 'source.webp')
  const outputPath = join(tempDir, 'converted.png')

  try {
    await writeFile(inputPath, imageBuffer)
    const sipsArgs = ['-s', 'format', 'png']
    if (size) {
      sipsArgs.push('-z', String(size.height), String(size.width))
    }
    sipsArgs.push(inputPath, '--out', outputPath)
    await execFileAsync('sips', sipsArgs)
    return await readFile(outputPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new PlatformApiError(
      'oppo',
      'invalid_image',
      `Failed to convert image to png: ${imageUrl}; ${reason}`
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export class OppoService implements PlatformService {
  readonly platform = 'oppo'
  readonly displayName = 'OPPO 应用商店'

  getCredentialSchema(): CredentialField[] {
    return [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'OPPO 开放平台 Client ID'
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'OPPO 开放平台 Client Secret'
      },
      {
        key: 'packageName',
        label: '包名 (Package Name)',
        type: 'text',
        required: true,
        placeholder: 'com.example.app'
      },
      {
        key: 'iconPath',
        label: '图标路径（可选）',
        type: 'text',
        required: false,
        placeholder: '本地文件路径或 https:// 图片链接，留空则使用后台图标'
      }
    ]
  }

  /** 查询应用已有元数据（提交版本时复用，避免缺字段被拒） */
  private async queryApp(
    pkgName: string,
    token: string,
    clientSecret: string
  ): Promise<OppoAppData> {
    const res = await axios.get<{ errno: number; data?: OppoAppData }>(
      `${OPPO_DOMAIN}/resource/v1/app/info`,
      {
        params: signParams({ pkg_name: pkgName }, token, clientSecret),
        timeout: META_TIMEOUT_MS
      }
    )
    if (res.data?.errno !== 0 || !res.data.data) {
      throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
    }
    return res.data.data
  }

  /** 上传 APK 文件，返回 { url, md5 } */
  private async uploadApk(
    apkPath: string,
    token: string,
    clientSecret: string
  ): Promise<{ url: string; md5: string }> {
    // Step 1: 获取上传地址
    const urlRes = await axios.get<{
      errno: number
      data?: { upload_url?: string; sign?: string }
    }>(`${OPPO_DOMAIN}/resource/v1/upload/get-upload-url`, {
      params: signParams({}, token, clientSecret),
      timeout: META_TIMEOUT_MS
    })
    if (urlRes.data?.errno !== 0 || !urlRes.data.data?.upload_url || !urlRes.data.data.sign) {
      throw new PlatformApiError('oppo', urlRes.data?.errno, parseOppoError(urlRes.data))
    }

    // Step 2: 上传文件
    const form = new FormData()
    form.append('sign', urlRes.data.data.sign)
    form.append('type', 'apk')
    form.append('file', createReadStream(apkPath))

    const uploadRes = await axios.post<{
      errno: number
      data?: { url?: string; md5?: string }
    }>(urlRes.data.data.upload_url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    if (uploadRes.data?.errno !== 0 || !uploadRes.data.data?.url) {
      throw new PlatformApiError('oppo', uploadRes.data?.errno, parseOppoError(uploadRes.data))
    }
    return { url: uploadRes.data.data.url, md5: uploadRes.data.data.md5 ?? '' }
  }

  /** 读取本地图片文件并通过 OPPO 上传接口获取合规 URL */
  private async uploadLocalPhoto(
    filePath: string,
    token: string,
    clientSecret: string,
    size?: { width: number; height: number }
  ): Promise<string> {
    const rawBuffer = await readFile(filePath)
    const pngBuffer = await convertImageToPng(rawBuffer, filePath, size)

    const urlRes = await axios.get<{
      errno: number
      data?: { upload_url?: string; sign?: string }
    }>(`${OPPO_DOMAIN}/resource/v1/upload/get-upload-url`, {
      params: signParams({}, token, clientSecret),
      timeout: META_TIMEOUT_MS
    })
    if (urlRes.data?.errno !== 0 || !urlRes.data.data?.upload_url || !urlRes.data.data.sign) {
      throw new PlatformApiError('oppo', urlRes.data?.errno, parseOppoError(urlRes.data))
    }

    const form = new FormData()
    form.append('sign', urlRes.data.data.sign)
    form.append('type', 'photo')
    form.append('file', pngBuffer, { filename: 'icon.png', contentType: 'image/png' })

    const uploadRes = await axios.post<{
      errno: number
      data?: { url?: string; md5?: string }
    }>(urlRes.data.data.upload_url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    if (uploadRes.data?.errno !== 0 || !uploadRes.data.data?.url) {
      throw new PlatformApiError('oppo', uploadRes.data?.errno, parseOppoError(uploadRes.data))
    }
    return uploadRes.data.data.url
  }

  /** 下载远程图片并通过 OPPO 上传接口获取合规 URL */
  private async uploadPhoto(
    imageUrl: string,
    token: string,
    clientSecret: string,
    size?: { width: number; height: number }
  ): Promise<string> {
    const dl = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000
    })
    const rawBuffer = Buffer.from(dl.data)
    const pngBuffer = await convertImageToPng(rawBuffer, imageUrl, size)

    const urlRes = await axios.get<{
      errno: number
      data?: { upload_url?: string; sign?: string }
    }>(`${OPPO_DOMAIN}/resource/v1/upload/get-upload-url`, {
      params: signParams({}, token, clientSecret),
      timeout: META_TIMEOUT_MS
    })
    if (urlRes.data?.errno !== 0 || !urlRes.data.data?.upload_url || !urlRes.data.data.sign) {
      throw new PlatformApiError('oppo', urlRes.data?.errno, parseOppoError(urlRes.data))
    }

    const form = new FormData()
    form.append('sign', urlRes.data.data.sign)
    form.append('type', 'photo')
    form.append('file', pngBuffer, { filename: 'image.png', contentType: 'image/png' })

    const uploadRes = await axios.post<{
      errno: number
      data?: { url?: string; md5?: string }
    }>(urlRes.data.data.upload_url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    if (uploadRes.data?.errno !== 0 || !uploadRes.data.data?.url) {
      throw new PlatformApiError('oppo', uploadRes.data?.errno, parseOppoError(uploadRes.data))
    }
    return uploadRes.data.data.url
  }



  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)
    const pkgName = creds.packageName
    const releaseNotes = (meta.releaseNotes ?? '').trim()
    const safeTestDesc = releaseNotes || '常规功能验证通过'
    const logStage = (message: string): void => {
      meta.log?.(message)
    }

    // Step 1: 查询应用已有元数据
    const app = await this.queryApp(pkgName, token, creds.clientSecret)
    const screenshotUrls = (app.pic_url ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)
    logStage(`[oppo] source icon_url: ${app.icon_url ?? ''}`)
    logStage(`[oppo] source screenshot_urls: ${JSON.stringify(screenshotUrls)}`)

    // Step 2: 上传 APK
    const apk = await this.uploadApk(apkPath, token, creds.clientSecret)
    const apkUrl = JSON.stringify([{ url: apk.url, md5: apk.md5, cpu_code: 0 }])

    // Step 3: 重传 icon 和截图（queryApp 返回的 CDN URL 不能直接用于 app/upd）
    let safeIconUrl = ''
    if (creds.iconPath?.trim()) {
      const iconSrc = creds.iconPath.trim()
      const isRemote = /^https?:\/\//i.test(iconSrc)
      logStage(`[oppo] uploading icon from ${isRemote ? 'remote url' : 'local path'}: ${iconSrc}`)
      safeIconUrl = isRemote
        ? await this.uploadPhoto(iconSrc, token, creds.clientSecret, { width: OPPO_ICON_SIZE, height: OPPO_ICON_SIZE })
        : await this.uploadLocalPhoto(iconSrc, token, creds.clientSecret, { width: OPPO_ICON_SIZE, height: OPPO_ICON_SIZE })
    } else if (app.icon_url) {
      logStage(`[oppo] re-uploading icon from: ${app.icon_url} as ${OPPO_ICON_SIZE}x${OPPO_ICON_SIZE} png`)
      safeIconUrl = await this.uploadPhoto(app.icon_url, token, creds.clientSecret, {
        width: OPPO_ICON_SIZE,
        height: OPPO_ICON_SIZE
      })
    }

    let safePicUrl = ''
    if (app.pic_url) {
      logStage(`[oppo] re-uploading ${screenshotUrls.length} screenshots with ${OPPO_SCREENSHOT_WIDTH}x${OPPO_SCREENSHOT_HEIGHT}`)
      const newUrls: string[] = []
      for (const rawUrl of screenshotUrls) {
        const url = await this.uploadPhoto(rawUrl, token, creds.clientSecret, { width: OPPO_SCREENSHOT_WIDTH, height: OPPO_SCREENSHOT_HEIGHT })
        newUrls.push(url)
      }
      safePicUrl = newUrls.join(',')
    }
    logStage(`[oppo] icon_url: ${safeIconUrl}`)
    logStage(`[oppo] pic_url: ${safePicUrl}`)


    // Step 4: 提交版本（online_type=1 表示审核通过后立即发布）
    const values: Record<string, string> = {
      pkg_name: pkgName,
      version_code: String(meta.versionCode),
      apk_url: apkUrl,
      app_name: app.app_name ?? '',
      second_category_id: app.second_category_id ?? '',
      third_category_id: app.third_category_id ?? '',
      summary: (app.summary ?? '').slice(0, 13),
      detail_desc: app.detail_desc ?? '',
      update_desc: releaseNotes,
      privacy_source_url: app.privacy_source_url ?? '',
      online_type: '1',
      test_desc: safeTestDesc,
      copyright_url: app.copyright_url ?? '',
      business_username: app.business_username ?? '',
      business_email: app.business_email ?? '',
      business_mobile: app.business_mobile ?? '',
      age_level: app.age_level ?? '',
      adaptive_equipment: app.adaptive_equipment ?? '',
      adaptive_type: '2',
      customer_contact: app.customer_contact ?? '',
      icon_url: safeIconUrl,
      pic_url: safePicUrl
    }

    const res = await axios.post<{ errno: number }>(
      `${OPPO_DOMAIN}/resource/v1/app/upd`,
      new URLSearchParams(signParams(values, token, creds.clientSecret)).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: META_TIMEOUT_MS
      }
    )
    const errno = res.data?.errno
    // 911215/911216 不是真正的失败：版本已在审核队列或上一个任务处理中
    if (errno !== 0 && errno !== OPPO_UNDER_REVIEW && errno !== OPPO_TASK_IN_FLIGHT) {
      throw new PlatformApiError('oppo', errno, parseOppoError(res.data))
    }

    // 返回 version_code 作为审核任务 ID（轮询时配合 creds.packageName 使用）
    return String(meta.versionCode)
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)

    const res = await axios.post<{
      errno: number
      data?: { task_state?: string; err_msg?: string }
    }>(
      `${OPPO_DOMAIN}/resource/v1/app/task-state`,
      new URLSearchParams(
        signParams(
          { pkg_name: creds.packageName, version_code: auditTaskId },
          token,
          creds.clientSecret
        )
      ).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: META_TIMEOUT_MS
      }
    )

    if (res.data?.errno !== 0) {
      throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
    }

    // task_state: 2=成功, 3=失败, 其它=处理中
    const state = res.data.data?.task_state
    if (state === '2') return 'passed'
    if (state === '3') return 'failed'
    return 'pending'
  }

  async publish(): Promise<void> {
    // OPPO 提交时已使用 online_type=1（审核通过后自动发布），无需单独的上架接口
  }

  async verify(creds: Record<string, string>): Promise<void> {
    await getAccessToken(creds.clientId, creds.clientSecret)
  }
}
