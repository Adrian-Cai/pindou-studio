/** 只根据宿主提供的平台字段识别 QQ 运行环境；字段缺失时按微信兼容运行。 */
export function isQqEnvironment(): boolean {
  try {
    const qqApi = (globalThis as typeof globalThis & {
      qq?: { getSystemInfoSync?(): { AppPlatform?: string } }
    }).qq;
    const info = (qqApi?.getSystemInfoSync?.() ?? wx.getSystemInfoSync()) as {
      AppPlatform?: string
    };
    return info.AppPlatform?.toLowerCase() === "qq";
  } catch {
    return false
  }
}
