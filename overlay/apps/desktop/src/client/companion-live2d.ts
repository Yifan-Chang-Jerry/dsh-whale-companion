/** Local Live2D preview owns its WebGL resources, animation clock, and pixel hit testing. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { Application, utils } from 'pixi.js'
import type { Cubism4InternalModel, Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import { AVATAR_EXPRESSIONS, AVATAR_MOTIONS, avatarControlsSchema, avatarExpressionSchema, avatarMotionSchema, type AvatarPreferences, type AvatarSnapshot, type AvatarPlayback } from '../companion/avatar.ts'
import { notificationSpeechFrame, type NotificationSpeech } from '../companion/notification.ts'

const previewSchema = z.object({
  model: z.string().min(1),
  controls: z.string().min(1),
  maxFps: z.number().min(1).max(60),
  maskSize: z.number().int().min(256).max(4096),
  maskBuffers: z.number().int().min(1).max(8),
  expressions: z.record(z.string(), z.string().nullable()),
  bodyParameter: z.string().min(1),
  bodyValues: z.array(z.number().finite()).min(1),
  idle: z.object({
    group: z.string().min(1),
    motion: z.object({ file: z.string().min(1), weight: z.number().min(0).max(1), followFadeSeconds: z.number().min(.05).max(2) }),
    firstActionDelaySeconds: z.number().min(0).max(120),
    restSeconds: z.number().min(1).max(300),
    blinkIntervalSeconds: z.number().min(1).max(20),
    gaze: z.object({
      x: z.string().min(1), y: z.string().min(1), z: z.string().min(1),
      originDrawables: z.array(z.string().min(1)).min(1),
      body: z.object({ x: z.string().min(1), y: z.string().min(1), z: z.string().min(1), amplitude: z.number().min(0).max(30), responseSeconds: z.number().min(.05).max(3) }),
    }),
    parameters: z.array(z.object({ id: z.string().min(1), center: z.number().finite(), amplitude: z.number().min(0).max(30), periodSeconds: z.number().min(1).max(120), phase: z.number().finite() })),
    actions: z.array(z.object({ group: z.string().min(1), holdSeconds: z.number().min(0).max(60) })).min(1),
  }),
})

type IdleActionState = { kind: 'rest'; until: number }
  | { kind: 'enter' | 'leave'; index: number }
  | { kind: 'hold'; index: number; until: number }

/**
 * Load the development model and release pending loads and GPU resources when its canvas closes.
 * @param pose - Companion state used to select a configured model expression.
 * @param paused - Whether desktop visibility or motion preferences pause animation.
 * @param preferences - Persisted body, expression, and dance choices.
 * @param selection - Main-owned playback requests and reset sequence.
 * @param panelVisible - Whether the controls panel should suspend automatic hand gestures.
 * @param speech - Shared notification clock; null leaves mouth parameters to the original rig.
 * @returns Canvas reference, loading state, retry and action controls, and visible-pixel hit testing.
 */
export function useLive2dCharacter(pose: string, paused: boolean, preferences: AvatarPreferences,
  selection: AvatarSnapshot, panelVisible: boolean, speech: NotificationSpeech | null) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const poseRef = useRef(pose)
  const pausedRef = useRef(paused)
  const bodyRef = useRef(preferences.body)
  const controlsRef = useRef({ preferences, selection, panelVisible })
  const speechRef = useRef(speech)
  poseRef.current = pose
  pausedRef.current = paused
  bodyRef.current = preferences.body
  controlsRef.current = { preferences, selection, panelVisible }
  speechRef.current = speech
  const runtime = useRef<{ hitTest(x: number, y: number): boolean; wake(): void; perform(): void }>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const retry = useCallback(() => { location.reload() }, [])
  const hitTest = useCallback((x: number, y: number): boolean => runtime.current?.hitTest(x, y) ?? false, [])
  const perform = useCallback(() => { runtime.current?.perform() }, [])

  useEffect(() => {
    const view = canvas.current
    if (view === null) return
    const abort = new AbortController()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let disposed = false
    let failed = false
    let app: Application | undefined
    let model: Live2DModel | undefined
    let observer: ResizeObserver | undefined
    let frame: number | undefined
    let lastFrame = 0
    let nextFrame = 0
    let lastTick = 0
    let appliedExpression: string | null | undefined
    let expressionGeneration = 0
    let fittedBody: number | undefined
    let frameSeconds = 0
    let gaze: { x: number; y: number; radius: number } | undefined
    let pointerFocused = false
    const pixel = new Uint8Array(4)

    const fail = (error: unknown): void => {
      if (disposed || failed) return
      failed = true
      console.error('Companion Live2D preview failed:', error)
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      runtime.current = undefined
      observer?.disconnect()
      model?.destroy({ children: true, texture: true, baseTexture: true })
      model = undefined
      app?.destroy(false)
      app = undefined
      setPhase('failed')
    }

    const initialize = async (): Promise<void> => {
      const response = await fetch('./live2d/preview.json', { signal: abort.signal })
      if (!response.ok) throw new Error(`Live2D preview configuration: HTTP ${String(response.status)}`)
      const config = previewSchema.parse(await response.json())
      const frameInterval = 1000 / config.maxFps
      const modelUrl = new URL(config.model, new URL('./live2d/', location.href))
      if (modelUrl.origin !== location.origin || !modelUrl.pathname.startsWith('/live2d/')) {
        throw new Error('The preview model must stay inside the local Live2D directory')
      }
      const bodyMotionUrl = new URL(config.idle.motion.file, new URL('./live2d/', location.href))
      if (bodyMotionUrl.origin !== location.origin || !bodyMotionUrl.pathname.startsWith('/live2d/')) {
        throw new Error('The body motion must stay inside the local Live2D directory')
      }
      const bodyMotionResponse = await fetch(bodyMotionUrl, { signal: abort.signal })
      if (!bodyMotionResponse.ok) throw new Error(`Live2D body motion: HTTP ${String(bodyMotionResponse.status)}`)
      const bodyMotionJson = await bodyMotionResponse.json()
      const controlsUrl = new URL(config.controls, new URL('./live2d/', location.href))
      if (controlsUrl.origin !== location.origin || !controlsUrl.pathname.startsWith('/live2d/')) throw new Error('The model controls must stay inside the local Live2D directory')
      const controlsResponse = await fetch(controlsUrl, { signal: abort.signal })
      if (!controlsResponse.ok) throw new Error(`Live2D model controls: HTTP ${String(controlsResponse.status)}`)
      const controls = avatarControlsSchema.parse(await controlsResponse.json())
      if (new Set(controls.expressions.map(p => p.id)).size !== avatarExpressionSchema.options.length
        || new Set(controls.motions.map(p => p.id)).size !== avatarMotionSchema.options.length) throw new Error('The prepared controls do not cover the model catalog')
      const PIXI = await import('pixi.js')
      await import('@pixi/unsafe-eval')
      const live2d = await import('pixi-live2d-display-lipsyncpatch/cubism4')
      const { Live2DModel, MotionPriority, MotionPreloadStrategy } = live2d
      // This release omits the exported queue constructor from its declarations.
      const { CubismMotionQueueManager } = live2d as typeof live2d & {
        CubismMotionQueueManager: new () => Cubism4InternalModel['motionManager']['queueManager']
      }
      if (disposed) return
      const loaded = await Live2DModel.from(modelUrl.href, {
        autoUpdate: false, autoHitTest: false, autoFocus: false,
        idleMotionGroup: config.idle.group, motionPreload: MotionPreloadStrategy.ALL,
      })
      if (disposed) { loaded.destroy({ children: true, texture: true, baseTexture: true }); return }
      model = loaded
      app = new PIXI.Application({
        view, width: view.clientWidth, height: view.clientHeight,
        backgroundAlpha: 0, antialias: true, autoStart: false,
        resolution: Math.min(devicePixelRatio, 2), autoDensity: true, preserveDrawingBuffer: true,
      })
      const application = app
      const renderer = application.renderer
      if (!(renderer instanceof PIXI.Renderer)) throw new Error('Live2D requires a WebGL renderer')
      application.stage.addChild(loaded)
      loaded.anchor.set(0, 0)
      // This release's declarations omit the inherited EventEmitter import.
      const internal = loaded.internalModel as Cubism4InternalModel & utils.EventEmitter
      const rawParameters = internal.coreModel.getModel().parameters
      const defaults = new Map(rawParameters.ids.map((id, index) => [id, rawParameters.defaultValues[index]!] as const))
      const layers = controls.expressions.map(preset => ({ ...preset, weight: 0 }))
      for (const layer of layers) for (const parameter of layer.parameters) {
        if (!defaults.has(parameter.id)) throw new Error(`Live2D expression parameter is unavailable: ${parameter.id}`)
      }
      const earlyDefaults = new Map(layers.flatMap(layer => layer.parameters.filter(p => p.early).map(p => [p.id, defaults.get(p.id)!] as const)))
      let mouthOwned = false
      internal.on('beforeMotionUpdate', () => {
        for (const [id, value] of earlyDefaults) internal.coreModel.setParameterValueById(id, value)
        if (mouthOwned) {
          internal.coreModel.setParameterValueById('ParamMouthOpenY', defaults.get('ParamMouthOpenY') ?? 0)
          internal.coreModel.setParameterValueById('ParamMouthForm', defaults.get('ParamMouthForm') ?? 0)
          mouthOwned = false
        }
      })
      const motionParameters = new Map(controls.motions.map(motion => [motion.id, new Set(motion.parameters)] as const))
      const resetParameters = new Set(controls.motions.flatMap(motion => motion.parameters).filter(id => defaults.has(id)))
      let playback: AvatarPlayback | undefined
      let finishedSequence = -1
      let appliedAgentSequence = -1
      let resetSequence = controlsRef.current.selection.resetSequence
      let fullBaseline: Map<string, number> | undefined
      let fullLastValues: Map<string, number> | undefined
      let recovery: { from: Map<string, number>; elapsed: number } | undefined
      const restoreFull = (): void => {
        if (fullBaseline !== undefined) {
          for (const [id, value] of fullBaseline) if (!config.idle.parameters.some(p => p.id === id)) internal.coreModel.setParameterValueById(id, value)
          if (fullLastValues !== undefined) recovery = { from: fullLastValues, elapsed: 0 }
        }
        fullBaseline = undefined
        fullLastValues = undefined
      }
      const applyLayers = (early: boolean): void => {
        const active = new Set(controlsRef.current.preferences.expressions)
        const full = playback !== undefined && AVATAR_MOTIONS[playback.motion].full
        const owned = playback === undefined ? undefined : motionParameters.get(playback.motion)
        for (const layer of layers) {
          const spec = AVATAR_EXPRESSIONS[layer.id]
          if (spec.body !== undefined) continue
          if (early) {
            const target = active.has(layer.id) && !(playback?.motion === 'showcase' && (spec.category === 'face' || spec.category === 'pose')) ? 1 : 0
            const blend = pausedRef.current || reduced.matches || document.hidden ? 1 : -Math.expm1(-frameSeconds / layer.fadeSeconds)
            layer.weight += (target - layer.weight) * blend
          }
          if (layer.weight < .0001) continue
          for (const parameter of layer.parameters) {
            if (parameter.early !== early || owned?.has(parameter.id) && (full || parameter.id.startsWith('Movement'))) continue
            if (parameter.blend === 'Add') internal.coreModel.addParameterValueById(parameter.id, parameter.value * layer.weight)
            else if (parameter.blend === 'Multiply') internal.coreModel.multiplyParameterValueById(parameter.id, 1 + (parameter.value - 1) * layer.weight)
            else internal.coreModel.setParameterValueById(parameter.id, parameter.value, layer.weight)
          }
        }
      }
      const bodyMotion = internal.motionManager.createMotion(bodyMotionJson, config.idle.group, { File: bodyMotionUrl.href })
      const bodyMotions = new CubismMotionQueueManager()
      internal.once('destroy', () => { bodyMotions.release(); bodyMotion.release() })
      bodyMotion.setIsLoop(true)
      bodyMotion.setIsLoopFadeIn(false)
      bodyMotion.setWeight(config.idle.motion.weight)
      bodyMotions.startMotion(bodyMotion, false, 0)
      internal.renderer.initialize(internal.coreModel, config.maskBuffers)
      internal.renderer.setClippingMaskBufferSize(config.maskSize)
      internal.idParamAngleX = config.idle.gaze.x
      internal.idParamAngleY = config.idle.gaze.y
      internal.idParamAngleZ = config.idle.gaze.z
      const gazeDrawables = config.idle.gaze.originDrawables.map(id => {
        const index = internal.coreModel.getDrawableIndex(id)
        if (index < 0) throw new Error(`Live2D gaze drawable is unavailable: ${id}`)
        return index
      })
      const blink = internal.eyeBlink
      delete internal.eyeBlink
      blink?.setBlinkingInterval(config.idle.blinkIntervalSeconds)
      const bodyGaze = config.idle.gaze.body
      for (const id of [bodyGaze.x, bodyGaze.y, bodyGaze.z]) {
        if (!internal.coreModel.getModel().parameters.ids.includes(id)) throw new Error(`Live2D body parameter is unavailable: ${id}`)
      }
      let bodyFocusX = 0
      let bodyFocusY = 0
      let bodyFocusZ = 0
      let bodyMotionWeight = config.idle.motion.weight
      internal.on('afterMotionUpdate', () => {
        internal.coreModel.setParameterValueById(config.bodyParameter, config.bodyValues[bodyRef.current] ?? config.bodyValues[0]!)
        const full = playback !== undefined && AVATAR_MOTIONS[playback.motion].full
        const owned = playback === undefined ? undefined : motionParameters.get(playback.motion)
        if (!owned?.has('ParamEyeROpen')) blink?.updateParameters(internal.coreModel, frameSeconds)
        const time = loaded.elapsedTime / 1000
        for (const parameter of full ? [] : config.idle.parameters) {
          internal.coreModel.setParameterValueById(parameter.id,
            parameter.center + Math.sin(time * Math.PI * 2 / parameter.periodSeconds + parameter.phase) * parameter.amplitude)
        }
        const motionBlend = -Math.expm1(-frameSeconds / config.idle.motion.followFadeSeconds)
        bodyMotionWeight += ((pointerFocused || full ? 0 : config.idle.motion.weight) - bodyMotionWeight) * motionBlend
        bodyMotion.setWeight(bodyMotionWeight)
        if (!full) bodyMotions.doUpdateMotion(internal.coreModel, time)
        if (full) internal.focusController.focus(0, 0, true)
        const focus = internal.focusController
        const blend = -Math.expm1(-frameSeconds / bodyGaze.responseSeconds)
        bodyFocusX += (focus.x * bodyGaze.amplitude - bodyFocusX) * blend
        bodyFocusY += (focus.y * bodyGaze.amplitude - bodyFocusY) * blend
        bodyFocusZ += (-focus.x * focus.y * bodyGaze.amplitude - bodyFocusZ) * blend
        // Drive the rig's inputs before its physics updates the torso, hips, and legs.
        if (!full) {
          internal.coreModel.addParameterValueById(bodyGaze.x, bodyFocusX)
          internal.coreModel.addParameterValueById(bodyGaze.y, bodyFocusY)
          internal.coreModel.addParameterValueById(bodyGaze.z, bodyFocusZ)
        }
        if (recovery !== undefined) {
          recovery.elapsed += frameSeconds
          const blend = Math.min(1, recovery.elapsed / .5)
          for (const [id, value] of recovery.from) internal.coreModel.setParameterValueById(id, value + (internal.coreModel.getParameterValueById(id) - value) * blend)
          if (blend === 1) recovery = undefined
        }
        applyLayers(true)
        if (full && owned !== undefined) fullLastValues = new Map([...owned].map(id => [id, internal.coreModel.getParameterValueById(id)] as const))
      })
      internal.on('beforeModelUpdate', () => {
        applyLayers(false)
        internal.coreModel.setParameterValueById(config.bodyParameter, config.bodyValues[bodyRef.current] ?? config.bodyValues[0]!)
        const speech = speechRef.current
        if (speech !== null && !pausedRef.current && !reduced.matches && !document.hidden) {
          if (!defaults.has('ParamMouthOpenY') || !defaults.has('ParamMouthForm')) throw new Error('The Live2D model has no speech mouth parameters')
          const state = notificationSpeechFrame(speech, Date.now())
          if (!state.finished) {
            internal.coreModel.setParameterValueById('ParamMouthOpenY', state.mouth)
            internal.coreModel.setParameterValueById('ParamMouthForm', speech.mouthForm)
            mouthOwned = true
          }
        }
      })
      let actionState: IdleActionState = { kind: 'rest', until: config.idle.firstActionDelaySeconds * 1000 }
      let actionGeneration = 0
      let nextAction = 0
      let requestedAction = false
      const motionEvents = internal.motionManager as typeof internal.motionManager & utils.EventEmitter
      motionEvents.on('motionFinish', () => {
        if (playback !== undefined) {
          const spec = AVATAR_MOTIONS[playback.motion]
          if (internal.motionManager.state.currentGroup === spec.group && internal.motionManager.state.currentIndex === spec.index) {
            const sequence = playback.sequence
            restoreFull()
            playback = undefined
            finishedSequence = sequence
            void window.dshCompanion.command({ type: 'avatar-finished', sequence }).catch(fail)
            return
          }
        }
        const state = actionState
        if (disposed || failed || (state.kind !== 'enter' && state.kind !== 'leave')) return
        const action = config.idle.actions[state.index]!
        const playing = internal.motionManager.state
        if (playing.currentGroup !== action.group || playing.currentIndex !== (state.kind === 'leave' ? 1 : 0)) return
        if (state.kind === 'leave') {
          nextAction = (state.index + 1) % config.idle.actions.length
          actionState = { kind: 'rest', until: loaded.elapsedTime + config.idle.restSeconds * 1000 }
        } else actionState = { kind: 'hold', index: state.index, until: loaded.elapsedTime + action.holdSeconds * 1000 }
      })

      const playAction = (index: number, returning: boolean): void => {
        const action = config.idle.actions[index]!
        const generation = ++actionGeneration
        actionState = { kind: returning ? 'leave' : 'enter', index }
        void loaded.motion(action.group, returning ? 1 : 0, MotionPriority.FORCE).then(success => {
          if (!success && !disposed && !failed && generation === actionGeneration) fail(new Error(`Live2D action could not start: ${action.group}`))
        }).catch(fail)
      }

      const fit = (): void => {
        let left = Infinity
        let top = Infinity
        let right = -Infinity
        let bottom = -Infinity
        const core = internal.coreModel
        for (let index = 0; index < core.getDrawableCount(); index++) {
          if (core.getDrawableOpacity(index) <= .01) continue
          const bounds = internal.getDrawableBounds(index)
          left = Math.min(left, bounds.x)
          top = Math.min(top, bounds.y)
          right = Math.max(right, bounds.x + bounds.width)
          bottom = Math.max(bottom, bounds.y + bounds.height)
        }
        if (!(right > left && bottom > top)) throw new Error('The Live2D body has no visible drawable area')
        const width = view.clientWidth
        const height = view.clientHeight
        const scale = Math.min(width * .82 / (right - left), height * .94 / (bottom - top))
        loaded.scale.set(scale)
        loaded.position.set((width - (right - left) * scale) / 2 - left * scale,
          height - (bottom - top) * scale - top * scale - height * .02)
        let eyeLeft = Infinity
        let eyeTop = Infinity
        let eyeRight = -Infinity
        let eyeBottom = -Infinity
        for (const index of gazeDrawables) {
          const bounds = internal.getDrawableBounds(index)
          eyeLeft = Math.min(eyeLeft, bounds.x)
          eyeTop = Math.min(eyeTop, bounds.y)
          eyeRight = Math.max(eyeRight, bounds.x + bounds.width)
          eyeBottom = Math.max(eyeBottom, bounds.y + bounds.height)
        }
        const eyeCenter = loaded.toGlobal(internal.localTransform.apply(new PIXI.Point((eyeLeft + eyeRight) / 2, (eyeTop + eyeBottom) / 2)))
        gaze = { x: eyeCenter.x, y: eyeCenter.y, radius: (right - left) * scale / 2 }
        void window.dshCompanion.command({ type: 'avatar-face',
          y: Math.max(0, Math.min(1, (view.getBoundingClientRect().top + eyeCenter.y) / innerHeight)) })
        fittedBody = bodyRef.current
      }

      const draw = (time: number): void => {
        frame = undefined
        if (disposed || failed) return
        try {
          const refreshInterval = Math.min(time - lastTick, frameInterval)
          lastTick = time
          const still = pausedRef.current || reduced.matches || document.hidden
          // Use the nearest display refresh without discarding fractional frame time.
          if (time + refreshInterval / 2 >= nextFrame || lastFrame === 0 || still) {
            const selected = controlsRef.current
            const request = selected.selection.playback
            if (resetSequence !== selected.selection.resetSequence) {
              loaded.stopMotions()
              for (const id of resetParameters) internal.coreModel.setParameterValueById(id, defaults.get(id)!)
              playback = undefined
              fullBaseline = undefined
              fullLastValues = undefined
              recovery = undefined
              actionState = { kind: 'rest', until: loaded.elapsedTime + config.idle.restSeconds * 1000 }
              resetSequence = selected.selection.resetSequence
            }
            if (playback !== undefined && request?.sequence !== playback.sequence) {
              loaded.stopMotions()
              restoreFull()
              playback = undefined
            }
            if (!still) {
              const state = actionState
              if (poseRef.current !== 'idle' || selected.selection.manualHands || selected.panelVisible || request !== null || selected.selection.agent !== null) {
                requestedAction = false
                if (state.kind === 'enter' || state.kind === 'hold') playAction(state.index, true)
              } else if (state.kind === 'rest' && (requestedAction || loaded.elapsedTime >= state.until)) {
                requestedAction = false
                playAction(nextAction, false)
              } else if ((state.kind === 'enter' && requestedAction) || (state.kind === 'hold' && (requestedAction || loaded.elapsedTime >= state.until))) {
                playAction(state.index, true)
              }
              if (request !== null && request.sequence !== finishedSequence && playback === undefined && actionState.kind === 'rest') {
                playback = request
                const spec = AVATAR_MOTIONS[request.motion]
                if (spec.full) fullBaseline = new Map([...(motionParameters.get(request.motion) ?? [])].map(id => [id, internal.coreModel.getParameterValueById(id)] as const))
                void loaded.motion(spec.group, spec.index, MotionPriority.FORCE).then(success => {
                  if (disposed || failed || playback?.sequence !== request.sequence) return
                  if (!success) { fail(new Error(`Live2D selected motion could not start: ${request.motion}`)); return }
                  void window.dshCompanion.command({ type: 'avatar-started', sequence: request.sequence }).catch(fail)
                }).catch(fail)
              }
            }
            const manualFace = selected.preferences.expressions.some(id => AVATAR_EXPRESSIONS[id].category === 'face' || AVATAR_EXPRESSIONS[id].exclusive === 'glasses')
            const expression = manualFace || playback?.motion === 'showcase' ? null : config.expressions[poseRef.current] ?? null
            if (appliedExpression !== expression) {
              appliedExpression = expression
              const generation = ++expressionGeneration
              const manager = internal.motionManager.expressionManager
              if (manager !== undefined) manager.reserveExpressionIndex = -1
              if (expression === null) manager?.resetExpression()
              else {
                const index = manager?.getExpressionIndex(expression) ?? -1
                if (manager === undefined || index < 0) throw new Error(`Live2D expression is unavailable: ${expression}`)
                const cached = manager.expressions[index]
                if (cached !== undefined && cached !== null && manager.currentExpression === cached) manager.restoreExpression()
                else void manager.setExpression(index).then(success => {
                  if (!disposed && !failed && generation === expressionGeneration && !success) fail(new Error(`Live2D expression could not load: ${expression}`))
                }).catch(error => { if (generation === expressionGeneration) fail(error) })
              }
            }
            const elapsed = still || lastFrame === 0 ? 0 : Math.min(time - lastFrame, 100)
            frameSeconds = elapsed / 1000
            if (elapsed === 0) internal.update(0, loaded.elapsedTime)
            loaded.update(elapsed)
            application.render()
            if (elapsed > 0 && selected.selection.agent !== null && appliedAgentSequence !== selected.selection.agent.sequence) {
              appliedAgentSequence = selected.selection.agent.sequence
              void window.dshCompanion.command({ type: 'avatar-applied', sequence: appliedAgentSequence }).catch(fail)
            }
            if (fittedBody !== bodyRef.current) { fit(); application.render() }
            nextFrame = lastFrame === 0 || still ? time + frameInterval
              : nextFrame + Math.max(1, Math.floor((time + refreshInterval / 2 - nextFrame) / frameInterval) + 1) * frameInterval
            lastFrame = time
          }
          if (!still) frame = requestAnimationFrame(draw)
        } catch (error) { fail(error) }
      }
      const wake = (): void => {
        if (disposed || failed || frame !== undefined) return
        lastFrame = 0
        lastTick = 0
        frame = requestAnimationFrame(draw)
      }
      const resize = (): void => {
        if (disposed || failed) return
        const width = view.clientWidth
        const height = view.clientHeight
        if (width === 0 || height === 0) return
        renderer.resize(width, height)
        fittedBody = undefined
        wake()
      }
      runtime.current = {
        wake,
        perform() {
          if (pausedRef.current || reduced.matches || document.hidden || poseRef.current !== 'idle') return
          requestedAction = true
          wake()
        },
        hitTest(x, y) {
          const box = view.getBoundingClientRect()
          if (x < box.left || y < box.top || x >= box.right || y >= box.bottom) return false
          const gl = renderer.gl
          gl.readPixels(Math.floor((x - box.left) / box.width * view.width),
            view.height - 1 - Math.floor((y - box.top) / box.height * view.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          return pixel[3]! > 32
        },
      }
      observer = new ResizeObserver(resize)
      observer.observe(view)
      resize()
      setPhase('ready')
    }

    const wake = (): void => { runtime.current?.wake() }
    const focus = (event: MouseEvent): void => {
      if (model === undefined || gaze === undefined || pausedRef.current || reduced.matches || document.hidden) return
      pointerFocused = true
      const box = view.getBoundingClientRect()
      // Screen Y increases downward; Cubism's focus Y increases upward from the eyes.
      model.internalModel.focusController.focus((event.clientX - box.left - gaze.x) / gaze.radius,
        (gaze.y - (event.clientY - box.top)) / gaze.radius)
    }
    const contextLost = (event: Event): void => { event.preventDefault(); fail(new Error('Live2D WebGL context was lost')) }
    const unfocus = (): void => { pointerFocused = false; model?.internalModel.focusController.focus(0, 0) }
    reduced.addEventListener('change', wake)
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('mousemove', focus)
    document.addEventListener('mouseleave', unfocus)
    view.addEventListener('webglcontextlost', contextLost)
    void initialize().catch(fail)
    return () => {
      disposed = true
      abort.abort()
      runtime.current = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer?.disconnect()
      reduced.removeEventListener('change', wake)
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('mousemove', focus)
      document.removeEventListener('mouseleave', unfocus)
      view.removeEventListener('webglcontextlost', contextLost)
      model?.destroy({ children: true, texture: true, baseTexture: true })
      app?.destroy(false)
    }
  }, [])

  useEffect(() => { runtime.current?.wake() }, [pose, paused, preferences, selection, panelVisible, speech])
  return { canvas, phase, hitTest, retry, perform }
}
