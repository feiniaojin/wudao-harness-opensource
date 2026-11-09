// 安全审计 2026-11 C7 — 凭据物料段（credential material segments）的单一
// 出处。此前常量私有在 permission-rules.ts：文件工具
// （credentialMaterialPath）用它们把凭据读/写顶到 ask，但 shell 的
// workspace 安全只读类（permission-modes.safeWorkspaceSegment）够不着——
// workspace 根在 $HOME 时 `cat .ssh/id_rsa` / `head .aws/credentials`
// 零确认零收据（文件工具早已问，shell 是漏网路径）。
//
// 抽到独立模块让两侧共用同一份表与匹配语义（段匹配，非子串）。
// permission-rules 与 permission-modes 之间已有反向 import
// （rules → modes 的 FILE_EDIT_TOOLS），共享模块避免环。
//
// 语义保持 permission-rules 原样（夜移 010，OH-Py `*/dir/*` glob 同款）：
//   - 目录段（.ssh/.gnupg）需要"目录之下的东西"——字面叫 .ssh 的文件或
//     my-ssh-notes 这类散文不是凭据；
//   - 文件段（.aws/credentials 等）精确匹配或作为任意深度的尾部段。
/** 目录段：其下的任何路径都是凭据物料。 */
export const CREDENTIAL_DIR_SEGMENTS = [".ssh", ".gnupg"] as const;

/** 文件段：这些确切路径是凭据物料。 */
export const CREDENTIAL_FILE_SEGMENTS = [".aws/credentials", ".kube/config", ".wudao/.credentials.yaml"] as const;

/** 一个（已 normalize、已小写的）路径是否触及凭据物料；命中返回该路径，
 *  否则 undefined。normalize 由调用方负责（两侧的 normalize 语义不同：
 *  文件工具走 normalizePath，shell token 走 workspaceSafeToken 风格——
 *  这里只做段匹配）。 */
export function credentialSegmentHit(p: string): string | undefined {
  for (const seg of CREDENTIAL_DIR_SEGMENTS) {
    if (p.startsWith(`${seg}/`) || p.includes(`/${seg}/`)) return p;
  }
  for (const f of CREDENTIAL_FILE_SEGMENTS) {
    if (p === f || p.includes(`/${f}`)) return p;
  }
  return undefined;
}
