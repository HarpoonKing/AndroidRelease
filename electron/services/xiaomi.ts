import axios from 'axios'
import FormData from 'form-data'
import { createHash, createPublicKey, constants, publicEncrypt } from 'crypto'
import { createReadStream } from 'fs'
import { basename } from 'path'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

const XIAOMI_BASE = 'https://api.developer.xiaomi.com/devupload'
const API_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000

const XIAOMI_CERT = `-----BEGIN CERTIFICATE-----
MIICsjCCAhugAwIBAgIUbANcYrk1DOkSSBAxRZo+FcIru9wwDQYJKoZIhvcNAQEE
BQAwajELMAkGA1UEBhMCQ04xEDAOBgNVBAgMB0JlaUppbmcxEDAOBgNVBAcMB0Jl
aUppbmcxDzANBgNVBAoMBnhpYW9taTENMAsGA1UECwwEbWl1aTEXMBUGA1UEAwwO
ZGV2LnhpYW9taS5jb20wIBcNMjMwMjIxMDIwOTA2WhgPMjEyMzAxMjgwMjA5MDZa
MGoxCzAJBgNVBAYTAkNOMRAwDgYDVQQIDAdCZWlKaW5nMRAwDgYDVQQHDAdCZWlK
aW5nMQ8wDQYDVQQKDAZ4aWFvbWkxDTALBgNVBAsMBG1pdWkxFzAVBgNVBAMMDmRl
di54aWFvbWkuY29tMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDAX+S8xIjM
tIvC3hDV1Pb9G0xeHKDP5C3yukb41kuvf+rVMTcSb4wxTWy7JlOMaRd6hWPUSNKs
kX+/aZin2FHlqJkAjP4SqNpSiG1le/0VYXmYRAtshm1DEcoCMyatwAoQU9jDtWu2
wPSyDXL/sS5qMufpdzJ1cG1VKVrAvxiOfQIDAQABo1MwUTAdBgNVHQ4EFgQUSerM
KItNhZ/Od9mhtMVd4vE/pBEwHwYDVR0jBBgwFoAUSerMKItNhZ/Od9mhtMVd4vE/
pBEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQQFAAOBgQCpyfyMQ1tXgiwb
d6j4kU8suUwwFdRcpnjoABwndExs38XF7EoLcHFHpt3WUmIs4fdnOD6+549n0usG
OCkRb8H47P7Y+qnJgH/YM42sZEp4vVHczr7MyOquQC/ZO5gnAwaYoVMkKqs06u5d
P/MMoedva3PCu9tBkNSQpAnle2BiYg==
-----END CERTIFICATE-----`

interface XiaomiPackageInfo {
  appName?: string
  versionCode?: number | string
}

interface XiaomiResponse {
  result: number
  message?: string
  reason?: string
  packageInfo?: XiaomiPackageInfo | null
}

interface XiaomiAuditRef {
  packageName: string
  versionCode: number
}

function md5Text(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function encryptSignature(payload: string): string {
  const publicKey = createPublicKey(XIAOMI_CERT)
  const source = Buffer.from(payload)
  const encrypted: Buffer[] = []
  for (let offset = 0; offset < source.length; offset += 117) {
    encrypted.push(publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      source.subarray(offset, offset + 117)
    ))
  }
  return Buffer.concat(encrypted).toString('hex')
}

async function buildSignedFields(
  request: Record<string, unknown>,
  privateKey: string,
  files: Array<{ name: string; path: string }> = []
): Promise<{ requestData: string; signature: string }> {
  const requestData = JSON.stringify(request)
  const sig: Array<{ name: string; hash: string }> = [
    { name: 'RequestData', hash: md5Text(requestData) }
  ]
  for (const file of files) {
    sig.push({ name: file.name, hash: await md5File(file.path) })
  }
  return {
    requestData,
    signature: encryptSignature(JSON.stringify({ sig, password: privateKey }))
  }
}

function checkResponse(response: XiaomiResponse, stage: string): void {
  if (response?.result !== 0) {
    throw new PlatformApiError(
      'xiaomi',
      response?.result ?? 'INVALID_RESPONSE',
      `${stage}失败: ${response?.message || response?.reason || '平台返回未知错误'}`
    )
  }
}

export class XiaomiService implements PlatformService {
  readonly platform = 'xiaomi'
  readonly displayName = '小米应用商店'

  getCredentialSchema(): CredentialField[] {
    return [
      { key: 'username', label: '开发者账号', type: 'text', required: true, placeholder: '小米开发者邮箱' },
      { key: 'privateKey', label: '接口密钥', type: 'password', required: true, placeholder: '小米开放平台接口密钥' },
      { key: 'packageName', label: '包名 (Package Name)', type: 'text', required: true, placeholder: 'com.example.app' }
    ]
  }

  private async queryPackage(creds: Record<string, string>): Promise<XiaomiPackageInfo | null> {
    const fields = await buildSignedFields(
      { packageName: creds.packageName, userName: creds.username },
      creds.privateKey
    )
    const body = new URLSearchParams({ RequestData: fields.requestData, SIG: fields.signature })
    const res = await axios.post<XiaomiResponse>(`${XIAOMI_BASE}/dev/query`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: API_TIMEOUT_MS
    })
    checkResponse(res.data, '查询应用')
    return res.data.packageInfo ?? null
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const appName = creds.appName?.trim()
    const iconPath = creds.iconPath?.trim()
    if (!appName || !iconPath) {
      throw new PlatformApiError('xiaomi', 'MISSING_APP_INFO', '应用名称或图标未配置')
    }

    meta.log?.('[xiaomi] 查询应用当前版本')
    const current = await this.queryPackage(creds)
    const currentVersionCode = Number(current?.versionCode ?? 0)
    if (current && Number.isFinite(currentVersionCode) && currentVersionCode >= meta.versionCode) {
      throw new PlatformApiError(
        'xiaomi',
        'VERSION_NOT_HIGHER',
        `商店版本号 ${currentVersionCode} 不低于待上传版本号 ${meta.versionCode}`
      )
    }

    const request = {
      synchroType: current ? 1 : 0,
      userName: creds.username,
      appInfo: {
        appName: current?.appName || appName,
        packageName: creds.packageName,
        updateDesc: meta.releaseNotes || '应用版本更新优化'
      }
    }
    const fields = await buildSignedFields(request, creds.privateKey, [
      { name: 'apk', path: apkPath },
      { name: 'icon', path: iconPath }
    ])
    const form = new FormData()
    form.append('RequestData', fields.requestData)
    form.append('SIG', fields.signature)
    form.append('apk', createReadStream(apkPath), { filename: basename(apkPath) })
    form.append('icon', createReadStream(iconPath), { filename: basename(iconPath) })

    meta.log?.(`[xiaomi] 上传${current ? '更新' : '新应用'}到开放平台`)
    const res = await axios.post<XiaomiResponse>(`${XIAOMI_BASE}/dev/push`, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    checkResponse(res.data, '上传应用')
    meta.log?.('[xiaomi] 上传完成，等待平台审核')
    return JSON.stringify({ packageName: creds.packageName, versionCode: meta.versionCode })
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const auditRef = JSON.parse(auditTaskId) as XiaomiAuditRef
    const current = await this.queryPackage({ ...creds, packageName: auditRef.packageName })
    const liveVersionCode = Number(current?.versionCode ?? 0)
    return liveVersionCode >= auditRef.versionCode ? 'passed' : 'pending'
  }

  async publish(): Promise<void> {
    // /dev/push 提交的版本审核通过后自动上架，小米没有单独发布接口。
  }
}
