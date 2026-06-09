import type { API } from '../../../electron/preload/index'

declare global {
  interface Window {
    api: API
  }
}
