import { useCallback, useEffect, useRef, useState } from 'react'
import { VideoUpscaler } from 'anime4k.js/upscaler'
import PresetSelector from './PresetSelector'
import ComparisonSlider from './ComparisonSlider'
import PRESETS from '../utils/presets'

const pickSupportedMimeType = (): string | undefined => {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

const stopStreamTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop())
}

export default function VideoDemo() {
  const [presetKey, setPresetKey] = useState(PRESETS[0].value)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null)
  const [recordingError, setRecordingError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const upscalerRef = useRef<VideoUpscaler | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordedChunksRef = useRef<BlobPart[]>([])
  const recordingTokenRef = useRef(0)
  const onVideoEndedRef = useRef<(() => void) | null>(null)

  const cancelRecording = useCallback(() => {
    recordingTokenRef.current += 1

    const video = videoRef.current
    const onEnded = onVideoEndedRef.current
    if (video && onEnded) {
      video.removeEventListener('ended', onEnded)
    }
    onVideoEndedRef.current = null

    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }
    recorderRef.current = null
    recordedChunksRef.current = []
    setRecording(false)
    setRecordingError(null)

    stopStreamTracks(recordingStreamRef.current)
    recordingStreamRef.current = null
  }, [])

  const cleanup = useCallback(() => {
    cancelRecording()
    if (upscalerRef.current) {
      upscalerRef.current.detachVideo()
      upscalerRef.current = null
    }
  }, [cancelRecording])

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    try {
      recorder.stop()
    } catch {
      // ignore
    }
  }, [])

  const startRecording = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    cancelRecording()
    setRecordedUrl(null)

    if (typeof MediaRecorder === 'undefined') {
      setRecordingError('MediaRecorder is not supported in this browser.')
      return
    }

    if (!canvas.captureStream) {
      setRecordingError('Canvas captureStream() is not supported in this browser.')
      return
    }

    if (canvas.width === 0 || canvas.height === 0) {
      setRecordingError('Upscaled canvas is not ready yet. Try again after the video loads.')
      return
    }

    const mimeType = pickSupportedMimeType()
    const token = (recordingTokenRef.current += 1)

    let audioTracks: MediaStreamTrack[] = []
    const captureStream = (video as unknown as { captureStream?: () => MediaStream }).captureStream
    if (typeof captureStream === 'function') {
      try {
        const mediaStream = captureStream.call(video)
        audioTracks = mediaStream.getAudioTracks()
      } catch {
        audioTracks = []
      }
    }

    const canvasStream = canvas.captureStream()
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ])
    recordingStreamRef.current = combinedStream

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(combinedStream, mimeType ? { mimeType } : undefined)
    } catch {
      stopStreamTracks(combinedStream)
      recordingStreamRef.current = null
      setRecordingError('Failed to start recording (unsupported codec or configuration).')
      return
    }

    recordedChunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (token !== recordingTokenRef.current) return
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data)
    }
    recorder.onerror = () => {
      if (token !== recordingTokenRef.current) return
      setRecordingError('Recording failed.')
      setRecording(false)
      stopStreamTracks(recordingStreamRef.current)
      recordingStreamRef.current = null
      recorderRef.current = null
    }
    recorder.onstop = () => {
      if (token !== recordingTokenRef.current) return
      setRecording(false)

      const chunks = recordedChunksRef.current
      recordedChunksRef.current = []

      const blobType = recorder.mimeType || 'video/webm'
      const blob = new Blob(chunks, { type: blobType })
      setRecordedUrl(URL.createObjectURL(blob))

      stopStreamTracks(recordingStreamRef.current)
      recordingStreamRef.current = null
      recorderRef.current = null

      const onEnded = onVideoEndedRef.current
      if (video && onEnded) video.removeEventListener('ended', onEnded)
      onVideoEndedRef.current = null
    }

    const onEnded = () => stopRecording()
    video.addEventListener('ended', onEnded)
    onVideoEndedRef.current = onEnded

    recorderRef.current = recorder
    setRecordingError(null)
    setRecording(true)
    recorder.start(1000)

    if (video.paused) {
      try {
        await video.play()
      } catch {
        // user can press play manually
      }
    }
  }, [cancelRecording, stopRecording])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    cleanup()
    if (videoUrl) URL.revokeObjectURL(videoUrl)

    setRecordedUrl(null)
    setVideoUrl(URL.createObjectURL(file))
    setDimensions(null)
  }, [videoUrl, cleanup])

  useEffect(() => {
    if (!recordedUrl) return
    return () => {
      URL.revokeObjectURL(recordedUrl)
    }
  }, [recordedUrl])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || !videoUrl) return

    const setup = () => {
      cleanup()

      const preset = PRESETS.find((p) => p.value === presetKey)
      if (!preset) return

      setDimensions({ width: video.videoWidth, height: video.videoHeight })

      const upscaler = new VideoUpscaler(preset.config)
      upscaler.attachVideo(video, canvas)
      upscaler.start()
      upscalerRef.current = upscaler
    }

    if (video.readyState >= 1) {
      setup()
    } else {
      video.addEventListener('loadedmetadata', setup, { once: true })
      return () => {
        video.removeEventListener('loadedmetadata', setup)
      }
    }

    return cleanup
  }, [videoUrl, presetKey, cleanup])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm transition-colors">
          Choose Video
          <input
            type="file"
            accept="video/mp4,video/webm"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
        <PresetSelector
          presets={PRESETS.map((p) => ({ label: p.label, value: p.value }))}
          value={presetKey}
          onChange={setPresetKey}
        />
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={!videoUrl}
          className={`px-4 py-2 rounded text-sm transition-colors disabled:opacity-50 ${
            recording
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {recording ? 'Stop Recording' : 'Start Recording'}
        </button>
        {recordedUrl && (
          <a
            href={recordedUrl}
            download={`anime4k-upscaled-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`}
            className="px-4 py-2 rounded text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors"
          >
            Download
          </a>
        )}
      </div>

      {recordingError && (
        <div className="text-sm text-red-300">
          {recordingError}
        </div>
      )}

      {videoUrl ? (
        <ComparisonSlider
          width={dimensions?.width ?? 0}
          height={dimensions?.height ?? 0}
        >
          {({ leftClip, rightClip }) => (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="absolute top-0 left-0 block"
                style={{
                  width: dimensions?.width,
                  height: dimensions?.height,
                  clipPath: dimensions ? leftClip : undefined,
                }}
              />
              <canvas
                ref={canvasRef}
                className="block pointer-events-none"
                style={{
                  width: dimensions?.width,
                  height: dimensions?.height,
                  clipPath: dimensions ? rightClip : undefined,
                }}
              />
            </>
          )}
        </ComparisonSlider>
      ) : (
        <div className="border-2 border-dashed border-gray-600 rounded-lg p-12 text-center text-gray-400">
          Select a video file to start
        </div>
      )}
    </div>
  )
}
