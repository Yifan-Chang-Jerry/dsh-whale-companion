/** Recognize a small set of opening character asides, outside quoted text and code. */
import type { AvatarExpression, AvatarMotion } from './avatar.ts'

/** One bounded reaction to an opening character aside. */
export interface NarrationCue { expressions: AvatarExpression[]; motion?: AvatarMotion }

/**
 * Map only an opening parenthesized aside to temporary expressions.
 * @param text - Current assistant reply, possibly still streaming; historical replies are filtered by the caller.
 * @returns Compatible expressions and one small gesture; ordinary prose and unsupported asides produce no action.
 */
export function narrationCue(text: string): NarrationCue {
  const aside = /^\s*[（(]([^（）()\n]{1,100})[）)]/.exec(text)?.[1]
  if (aside === undefined) return { expressions: [] }
  const expressions: AvatarExpression[] = []
  if (/脸红|害羞|不好意思/.test(aside)) expressions.push('blush')
  if (/冷汗|紧张|心虚/.test(aside)) expressions.push('sweat')
  if (/眼泪|流泪|哭/.test(aside)) expressions.push('tears')
  else if (/笑|开心|高兴|得意/.test(aside)) expressions.push('rabbit-teeth')
  if (/爱心|比心/.test(aside)) expressions.push('heart-eyes')
  if (/凑近|凑到|靠近|往.{0,12}靠|前倾/.test(aside)) expressions.push('lean')
  const motion = /点头/.test(aside) ? 'nod' : /歪头|歪.{0,4}脑袋/.test(aside) ? 'tilt'
    : /尾巴.{0,8}[晃摇]|摇.{0,3}尾巴|呆毛.{0,8}[抖晃]|轻轻摇摆/.test(aside) ? 'sway' : undefined
  return { expressions, ...(motion === undefined ? {} : { motion }) }
}
