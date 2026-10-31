/** Prepare private model controls and a composed dance without copying assets into release artifacts. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { AVATAR_EXPRESSIONS, AVATAR_HOTKEYS, AVATAR_MOTIONS, avatarExpressionSchema, avatarMotionSchema } from '../src/companion/avatar.ts'

const root = resolve(process.env.DSH_COMPANION_LIVE2D_DIR ?? join(import.meta.dirname, '..', '.desktop-build', 'live2d'))
const modelRoot = join(root, 'model')
const output = join(modelRoot, 'PreviewAnimation')
await mkdir(output, { recursive: true })
const curveSchema = z.object({ Target: z.string(), Id: z.string(), Segments: z.array(z.number().finite()).min(2) }).passthrough()
const motionSchema = z.object({ Version: z.literal(3), Meta: z.object({ Duration: z.number().positive(), Loop: z.boolean() }).passthrough(), Curves: z.array(curveSchema) }).passthrough()
const expressionSchema = z.object({ FadeInTime: z.number().optional(), Parameters: z.array(z.object({ Id: z.string(), Value: z.number().finite(), Blend: z.enum(['Add', 'Multiply', 'Overwrite']) })) })
const physics = z.object({ PhysicsSettings: z.array(z.object({ Input: z.array(z.object({ Source: z.object({ Id: z.string() }) })) })) })
  .parse(JSON.parse(await readFile(join(modelRoot, '大肥鱼.physics3.json'), 'utf8')))
const physicsInputs = new Set(physics.PhysicsSettings.flatMap(setting => setting.Input.map(input => input.Source.Id)))
const expressions = await Promise.all(avatarExpressionSchema.options.map(async id => {
  const data = expressionSchema.parse(JSON.parse(await readFile(join(modelRoot, 'Exp3', `${AVATAR_EXPRESSIONS[id].file}.exp3.json`), 'utf8')))
  return { id, fadeSeconds: Math.max(.05, data.FadeInTime ?? .5), parameters: data.Parameters.map(p => ({ id: p.Id, value: p.Value, blend: p.Blend, early: physicsInputs.has(p.Id) })) }
}))
const sourceExpressions = (await readdir(join(modelRoot, 'Exp3'))).filter(name => name.endsWith('.exp3.json'))
if (sourceExpressions.length !== expressions.length) throw new Error('The expression catalog does not cover every source expression')

const duration = AVATAR_MOTIONS.dance.seconds
const envelope = (t: number): number => .5 - .5 * Math.cos(Math.min(1, Math.max(0, Math.min(t, duration - t)) / 1.2) * Math.PI)
const wave = (t: number, period: number, phase = 0): number => Math.sin(t * Math.PI * 2 / period + phase)
const dance: Record<string, (t: number) => number> = {
  AngleX: t => -8 * wave(t, 2.4), AngleY: t => 4 * wave(t, .6, .35), AngleZ: t => -8 * wave(t, 1.2),
  PositionX: t => 12 * wave(t, 2.4), PositionY: t => 4 * wave(t, .6, -Math.PI / 2),
  PositionZ: t => 14 * wave(t, 1.2), LeanInput: t => 4 * wave(t, 4.8),
  Movement1: () => 0, Movement2: () => 1, Movement3: () => 1,
  Param40: () => 1, Param36: t => .025 + .01 * wave(t, 1.2), Param39: () => .2,
  Param41: t => .55 + .2 * wave(t, 1.2), Param42: t => .2 * wave(t, .6), Param43: t => .1 * wave(t, 1.2),
  Param62: t => .02 + .01 * wave(t, 1.2, Math.PI), Param59: () => .35,
  Param60: t => .6 + .15 * wave(t, 1.2, Math.PI), Param61: t => .12 * wave(t, .6, Math.PI),
  ParamMouthForm: () => .3, EyeSmile: () => .2,
}
const danceCurves = Object.entries(dance).map(([id, signal]) => {
  const sample = (t: number): number => envelope(t) * signal(t)
  const derivative = (t: number): number => (sample(t + .0001) - sample(t - .0001)) / .0002
  const segments = [0, sample(0)]
  const count = 160
  for (let i = 0; i < count; i++) {
    const a = i * duration / count, b = (i + 1) * duration / count, step = (b - a) / 3
    segments.push(1, a + step, sample(a) + derivative(a) * step, b - step, sample(b) - derivative(b) * step, b, sample(b))
  }
  return { Target: 'Parameter', Id: id, Segments: segments }
})
const danceJson = { Version: 3, Meta: { Duration: duration, Fps: 60, Loop: false, AreBeziersRestricted: true,
  CurveCount: danceCurves.length, TotalSegmentCount: danceCurves.length * 160, TotalPointCount: danceCurves.length * 481, UserDataCount: 0, TotalUserDataSize: 0 },
  FadeInTime: .5, FadeOutTime: .6, Curves: danceCurves }
await writeFile(join(output, 'dance.motion3.json'), `${JSON.stringify(danceJson)}\n`)

const gestures = {
  nod: { AngleY: (t: number) => -12 * wave(t, 1.2) },
  tilt: { AngleZ: (t: number) => 12 * Math.sin(t * Math.PI / 3), AngleX: (t: number) => 4 * Math.sin(t * Math.PI / 3) },
  sway: { AngleZ: (t: number) => 3.5 * wave(t, 2.4), PositionX: (t: number) => 5 * wave(t, 2.4), PositionZ: (t: number) => 4 * wave(t, 2.4), PositionY: (t: number) => 1.3 * wave(t, 1.2) },
}
const generated = new Map<string, typeof danceJson>([['dance', danceJson]])
for (const [id, signals] of Object.entries(gestures)) {
  const seconds = AVATAR_MOTIONS[id as 'nod' | 'tilt' | 'sway'].seconds
  const count = Math.round(seconds / .05)
  const curves = Object.entries(signals).map(([Id, signal]) => {
    const Segments = [0, 0]
    for (let index = 1; index <= count; index++) {
      const t = index * seconds / count
      const fade = .5 - .5 * Math.cos(Math.min(1, Math.min(t, seconds - t) / .4) * Math.PI)
      Segments.push(0, t, fade * signal(t))
    }
    return { Target: 'Parameter', Id, Segments }
  })
  generated.set(id, { ...danceJson, Meta: { ...danceJson.Meta, Duration: seconds, CurveCount: curves.length, TotalSegmentCount: curves.length * count, TotalPointCount: curves.length * (count + 1) }, Curves: curves })
}

const groups: Record<string, { File: string; FadeInTime: number; FadeOutTime: number }[]> = {}
const motions = []
for (const id of avatarMotionSchema.options) {
  const spec = AVATAR_MOTIONS[id]
  const source = spec.generated ? generated.get(id)! : motionSchema.parse(JSON.parse(await readFile(join(modelRoot, 'Animation', `${spec.file}.motion3.json`), 'utf8')))
  if (Math.abs(source.Meta.Duration - spec.seconds) > .002) throw new Error(`Unexpected motion duration: ${id}`)
  const prepared = { ...source, Meta: { ...source.Meta, Loop: id === 'ambient' }, FadeInTime: id === 'ambient' ? .8 : .25, FadeOutTime: id === 'ambient' ? .8 : .3 }
  const file = id === 'ambient' ? `Animation/${spec.file}.motion3.json` : `PreviewAnimation/${spec.file}.motion3.json`
  if (id !== 'ambient') await writeFile(join(modelRoot, file), `${JSON.stringify(prepared)}\n`)
  ;(groups[spec.group] ??= [])[spec.index] = { File: file, FadeInTime: prepared.FadeInTime, FadeOutTime: prepared.FadeOutTime }
  motions.push({ id, parameters: source.Curves.filter(c => c.Target === 'Parameter').map(c => c.Id) })
}
const sourceMotions = (await readdir(join(modelRoot, 'Animation'))).filter(name => name.endsWith('.motion3.json'))
if (sourceMotions.length !== avatarMotionSchema.options.filter(id => !AVATAR_MOTIONS[id].generated).length) throw new Error('The motion catalog does not cover every source motion')

const showcase = motionSchema.parse(JSON.parse(await readFile(join(modelRoot, 'Animation', `${AVATAR_MOTIONS.showcase.file}.motion3.json`), 'utf8')))
const bodyIds = new Set(['AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ'])
const bodyCurves = showcase.Curves.filter(curve => curve.Target === 'Parameter' && bodyIds.has(curve.Id))
if (bodyCurves.length !== bodyIds.size) throw new Error('The original showcase is missing a body motion parameter')
let segmentCount = 0
let pointCount = bodyCurves.length
for (const curve of bodyCurves) {
  for (let index = 2; index < curve.Segments.length;) {
    const kind = curve.Segments[index]
    if (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3) throw new Error('Unsupported Cubism motion segment')
    const size = kind === 1 ? 7 : 3
    if (index + size > curve.Segments.length) throw new Error('Incomplete Cubism motion segment')
    index += size
    segmentCount++
    pointCount += kind === 1 ? 3 : 1
  }
}
await writeFile(join(output, 'body-idle.motion3.json'), `${JSON.stringify({ ...showcase,
  Meta: { ...showcase.Meta, Loop: true, CurveCount: bodyCurves.length, TotalSegmentCount: segmentCount, TotalPointCount: pointCount },
  FadeInTime: .8, FadeOutTime: .8, Curves: bodyCurves })}\n`)

const vtube = z.object({ Hotkeys: z.array(z.object({ Action: z.string(), File: z.string(), Triggers: z.object({ Trigger1: z.string(), Trigger2: z.string(), Trigger3: z.string() }) })) })
  .parse(JSON.parse(await readFile(join(modelRoot, '大肥鱼.vtube.json'), 'utf8')))
const imported = vtube.Hotkeys.map(h => {
  const keys = [h.Triggers.Trigger1, h.Triggers.Trigger2, h.Triggers.Trigger3].filter(Boolean)
    .map(key => key === 'LeftShift' || key === 'RightShift' ? 'Shift' : /^N\d$/.test(key) ? key.slice(1) : key)
  const expression = avatarExpressionSchema.options.find(id => `${AVATAR_EXPRESSIONS[id].file}.exp3.json` === h.File)
  const motion = avatarMotionSchema.options.find(id => `${AVATAR_MOTIONS[id].file}.motion3.json` === h.File)
  const action = h.Action === 'RemoveAllExpressions' ? { kind: 'reset' } : h.Action === 'ToggleExpression' && expression !== undefined
    ? { kind: 'expression', id: expression } : h.Action === 'TriggerAnimation' && motion !== undefined ? { kind: 'motion', id: motion } : undefined
  if (action === undefined) throw new Error(`Unmapped author shortcut: ${h.File}`)
  return JSON.stringify({ accelerator: keys.join('+'), action })
}).sort()
if (JSON.stringify(imported) !== JSON.stringify(AVATAR_HOTKEYS.map(h => JSON.stringify(h)).sort())) throw new Error('The author shortcut catalog differs from the model package')

const model = z.object({ FileReferences: z.object({ Moc: z.string(), Textures: z.array(z.string()) }).passthrough() }).passthrough()
  .parse(JSON.parse(await readFile(join(modelRoot, '大肥鱼.model3.json'), 'utf8')))
model.FileReferences.Motions = groups
model.FileReferences.Expressions = avatarExpressionSchema.options.map(id => ({ Name: AVATAR_EXPRESSIONS[id].file, File: `Exp3/${AVATAR_EXPRESSIONS[id].file}.exp3.json` }))
await writeFile(join(modelRoot, 'preview.model3.json'), `${JSON.stringify(model, null, 2)}\n`)
await writeFile(join(output, 'controls.json'), `${JSON.stringify({ expressions, motions }, null, 2)}\n`)
const configFile = join(root, 'preview.json')
const config = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(configFile, 'utf8')))
config.controls = 'model/PreviewAnimation/controls.json'
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Prepared ${sourceMotions.length} original motions, ${expressions.length} expression presets, ${imported.length} author shortcuts, and ${generated.size} locally composed motions.`)
