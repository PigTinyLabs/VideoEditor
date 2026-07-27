import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Play, Pause, Scissors, Type, Upload, Download, Trash2, Plus, Music, Film, Image as ImageIcon, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";

// ---------- constants ----------
const CANVAS_W = 1280;
const CANVAS_H = 720;
const PX_PER_SEC_BASE = 60;
const TRACK_HEIGHT = 56;
const MIN_CLIP_SEC = 0.2;
const KEEP_WINDOW_SEC = 4; // how far around playhead we keep media elements warm
const PRELOAD_LEAD_SEC = 1.2; // start priming the next clip this many seconds before it's needed

const EFFECT_PRESETS = {
  none: { brightness: 100, contrast: 100, saturation: 100, blur: 0, vignette: 0 },
  warm: { brightness: 108, contrast: 105, saturation: 120, blur: 0, vignette: 10 },
  cool: { brightness: 100, contrast: 108, saturation: 90, blur: 0, vignette: 10 },
  mono: { brightness: 105, contrast: 115, saturation: 0, blur: 0, vignette: 15 },
  vintage: { brightness: 100, contrast: 92, saturation: 65, blur: 0, vignette: 35 },
  dramatic: { brightness: 92, contrast: 140, saturation: 105, blur: 0, vignette: 45 },
  dreamy: { brightness: 112, contrast: 90, saturation: 105, blur: 2, vignette: 20 },
};

const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3];

let idCounter = 1;
const uid = () => `id${idCounter++}_${Math.random().toString(36).slice(2, 7)}`;

// ---------- helpers ----------
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function layoutTrack(clips) {
  const sorted = [...clips].sort((a, b) => a.order - b.order);
  let out = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const prev = out[i - 1];
    const overlap = prev ? Math.min(prev.transitionOutDuration || 0, c.duration, prev.duration) : 0;
    const start = prev ? prev.start + prev.duration - overlap : 0;
    out.push({ ...c, start, end: start + c.duration });
  }
  return out;
}

function totalDurationOf(tracks) {
  let max = 0;
  for (const t of tracks) {
    const laid = layoutTrack(t.clips);
    for (const c of laid) max = Math.max(max, c.end);
  }
  return max;
}

function fadeMultiplier(time, clip) {
  const fadeIn = clip.fadeIn || 0;
  const fadeOut = clip.fadeOut || 0;
  const rel = time - clip.start;
  const remain = clip.end - time;
  let m = 1;
  if (fadeIn > 0 && rel < fadeIn) m *= clamp(rel / fadeIn, 0, 1);
  if (fadeOut > 0 && remain < fadeOut) m *= clamp(remain / fadeOut, 0, 1);
  return m;
}

function makeVideoClip(mediaItem, order) {
  return {
    kind: "video",
    id: uid(),
    mediaId: mediaItem.id,
    url: mediaItem.url,
    sourceDuration: mediaItem.duration,
    inPoint: 0,
    outPoint: mediaItem.duration,
    speed: 1,
    duration: mediaItem.duration,
    order,
    preset: "none",
    filters: { ...EFFECT_PRESETS.none },
    opacity: 100,
    transitionOutDuration: 0,
    transitionType: "crossfade",
    audioEnabled: true,
    volume: 100,
  };
}

function makeAudioClip(mediaItem, order) {
  return {
    kind: "audio",
    id: uid(),
    mediaId: mediaItem.id,
    url: mediaItem.url,
    sourceDuration: mediaItem.duration,
    inPoint: 0,
    outPoint: mediaItem.duration,
    duration: mediaItem.duration,
    order,
    volume: 80,
    fadeIn: 0.3,
    fadeOut: 0.3,
    transitionOutDuration: 0,
  };
}

function makeImageClip(mediaItem, order) {
  return {
    kind: "image",
    id: uid(),
    mediaId: mediaItem.id,
    url: mediaItem.url,
    duration: 3,
    order,
    preset: "none",
    filters: { ...EFFECT_PRESETS.none },
    opacity: 100,
    transitionOutDuration: 0,
    transitionType: "crossfade",
  };
}

function makeTextClip(order) {
  return {
    kind: "text",
    id: uid(),
    text: "Văn bản mới",
    duration: 3,
    order,
    x: 0.5,
    y: 0.85,
    fontSize: 48,
    color: "#ffffff",
    fontWeight: 700,
    align: "center",
    fadeIn: 0.2,
    fadeOut: 0.2,
    transitionOutDuration: 0,
  };
}

// ---------- main component ----------
export default function VideoEditor() {
  const [tracks, setTracks] = useState([
    { id: "track-v1", type: "video", name: "Video", clips: [] },
    { id: "track-audio", type: "audio", name: "Nhạc nền", clips: [] },
    { id: "track-txt", type: "text", name: "Chữ", clips: [] },
  ]);
  const [library, setLibrary] = useState([]); // {id, name, url, duration, kind:'video'|'audio'}
  const [selectedClipId, setSelectedClipId] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportUrl, setExportUrl] = useState(null);
  const [muted, setMuted] = useState(false);

  const canvasRef = useRef(null);
  const mediaPoolRef = useRef({}); // clipId -> {el, kind, gainNode?}
  const activeIdsPrevRef = useRef(new Set());
  const rafRef = useRef(null);
  const lastTsRef = useRef(null);
  const cleanupCounterRef = useRef(0);
  const dragRef = useRef(null);
  const videoFileInputRef = useRef(null);
  const audioFileInputRef = useRef(null);
  const imageFileInputRef = useRef(null);

  const duration = useMemo(() => Math.max(1, totalDurationOf(tracks)), [tracks]);
  const pxPerSec = PX_PER_SEC_BASE * zoom;

  const laidOutTracks = useMemo(() => tracks.map((t) => ({ ...t, laid: layoutTrack(t.clips) })), [tracks]);

  const selectedClip = useMemo(() => {
    for (const t of laidOutTracks) {
      const c = t.laid.find((c) => c.id === selectedClipId);
      if (c) return { ...c, trackId: t.id, trackType: t.type };
    }
    return null;
  }, [laidOutTracks, selectedClipId]);

  // ---------- import ----------
  const handleVideoFiles = useCallback((files) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("video/")) return;
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      v.onloadedmetadata = () => {
        setLibrary((lib) => [...lib, { id: uid(), name: file.name, url, duration: v.duration || 5, kind: "video" }]);
      };
    });
  }, []);

  const handleAudioFiles = useCallback((files) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("audio/")) return;
      const url = URL.createObjectURL(file);
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.src = url;
      a.onloadedmetadata = () => {
        setLibrary((lib) => [...lib, { id: uid(), name: file.name, url, duration: a.duration || 5, kind: "audio" }]);
      };
    });
  }, []);

  const handleImageFiles = useCallback((files) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const url = URL.createObjectURL(file);
      setLibrary((lib) => [...lib, { id: uid(), name: file.name, url, duration: null, kind: "image" }]);
    });
  }, []);

  const addClipToTrack = useCallback((trackId, mediaItem) => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== trackId) return t;
        const maxOrder = t.clips.reduce((m, c) => Math.max(m, c.order), -1);
        const clip =
          mediaItem.kind === "audio"
            ? makeAudioClip(mediaItem, maxOrder + 1)
            : mediaItem.kind === "image"
            ? makeImageClip(mediaItem, maxOrder + 1)
            : makeVideoClip(mediaItem, maxOrder + 1);
        return { ...t, clips: [...t.clips, clip] };
      })
    );
  }, []);

  const addTextClip = useCallback(() => {
    setTracks((prev) =>
      prev.map((t) => {
        if (t.type !== "text") return t;
        const maxOrder = t.clips.reduce((m, c) => Math.max(m, c.order), -1);
        return { ...t, clips: [...t.clips, makeTextClip(maxOrder + 1)] };
      })
    );
  }, []);

  const updateClip = useCallback((clipId, patch) => {
    setTracks((prev) => prev.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) })));
  }, []);

  const applyPreset = useCallback((clipId, presetName) => {
    updateClip(clipId, { preset: presetName, filters: { ...EFFECT_PRESETS[presetName] } });
  }, [updateClip]);

  const deleteClip = useCallback((clipId) => {
    setTracks((prev) => prev.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })));
    setSelectedClipId((s) => (s === clipId ? null : s));
    const pooled = mediaPoolRef.current[clipId];
    if (pooled) {
      try { pooled.el.pause(); pooled.el.src = ""; } catch (e) {}
      delete mediaPoolRef.current[clipId];
    }
  }, []);

  const splitClipAt = useCallback((clipId, timeAbs) => {
    setTracks((prev) =>
      prev.map((t) => {
        const laid = layoutTrack(t.clips);
        const target = laid.find((c) => c.id === clipId);
        if (!target) return t;
        const offset = timeAbs - target.start;
        if (offset <= MIN_CLIP_SEC || offset >= target.duration - MIN_CLIP_SEC) return t;
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== clipId) return [c];
            const hasSource = c.kind === "video" || c.kind === "audio";
            const speed = c.speed || 1;
            const srcOffset = offset * speed;
            const first = { ...c, duration: offset, outPoint: hasSource ? c.inPoint + srcOffset : undefined, transitionOutDuration: 0 };
            const second = {
              ...c,
              id: uid(),
              order: c.order + 0.5,
              duration: c.duration - offset,
              inPoint: hasSource ? c.inPoint + srcOffset : undefined,
              transitionOutDuration: c.transitionOutDuration,
            };
            return [first, second];
          }),
        };
      })
    );
  }, []);

  // ---------- media pool (lazy, windowed) ----------
  function getMediaEl(clip, kind) {
    let pooled = mediaPoolRef.current[clip.id];
    if (!pooled) {
      let el;
      if (kind === "image") {
        el = document.createElement("img");
        el.src = clip.url;
      } else {
        el = document.createElement(kind === "audio" ? "audio" : "video");
        el.src = clip.url;
        el.preload = "auto";
        el.muted = true;
        if (kind === "video") el.playsInline = true;
      }
      pooled = { el, kind };
      mediaPoolRef.current[clip.id] = pooled;
    }
    return pooled.el;
  }

  // release media elements far from the playhead to keep memory/decoding light when many clips exist
  function cleanupFarMedia(time, tracksLaid) {
    const keep = new Set();
    for (const t of tracksLaid) {
      if (t.type === "text") continue;
      for (const c of t.laid) {
        if (c.end >= time - KEEP_WINDOW_SEC && c.start <= time + KEEP_WINDOW_SEC) keep.add(c.id);
      }
    }
    for (const id of Object.keys(mediaPoolRef.current)) {
      if (!keep.has(id)) {
        const pooled = mediaPoolRef.current[id];
        try {
          if (pooled.kind !== "image") pooled.el.pause();
          pooled.el.removeAttribute("src");
          if (pooled.kind !== "image" && pooled.el.load) pooled.el.load();
        } catch (e) {}
        delete mediaPoolRef.current[id];
      }
    }
  }

  // ---------- rendering ----------
  const renderFrame = useCallback(
    (time) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      cleanupCounterRef.current++;
      if (cleanupCounterRef.current % 45 === 0) cleanupFarMedia(time, laidOutTracks);

      const nextActiveIds = new Set();

      for (const t of laidOutTracks) {
        if (t.type === "video") {
          const active = t.laid.filter((c) => time >= c.start && time < c.end);
          // prime the upcoming video clip slightly ahead so the cut is seamless (images need no priming)
          const upcoming = t.laid.find((c) => c.kind === "video" && c.start > time && c.start - time < PRELOAD_LEAD_SEC);
          if (upcoming) {
            const v = getVideoElSafe(upcoming);
            if (v && v.paused && Math.abs(v.currentTime - upcoming.inPoint) > 0.2) {
              try { v.currentTime = upcoming.inPoint; } catch (e) {}
            }
          }
          for (const c of active) {
            nextActiveIds.add(c.id);
            let alpha = (c.opacity ?? 100) / 100;
            let translateX = 0, scale = 1;
            const overlapCount = active.length;
            if (overlapCount > 1) {
              const idx = active.indexOf(c);
              const zoneStart = Math.max(...active.map((a) => a.start));
              const zoneEnd = Math.min(...active.map((a) => a.end));
              const zoneLen = Math.max(0.001, zoneEnd - zoneStart);
              const p = clamp((time - zoneStart) / zoneLen, 0, 1);
              const isLater = idx === active.length - 1;
              const transitionType = active[0].transitionType || "crossfade";
              if (transitionType === "crossfade") {
                alpha *= isLater ? p : 1 - p;
              } else if (transitionType === "zoom") {
                alpha *= isLater ? p : 1 - p;
                scale = isLater ? 1.18 - p * 0.18 : 1 + p * 0.18;
              } else if (transitionType === "slide") {
                translateX = isLater ? (1 - p) * CANVAS_W : -p * CANVAS_W;
              } else if (transitionType === "strobe") {
                const strobePhase = Math.floor(time * 15) % 2;
                alpha *= isLater ? strobePhase : 1 - strobePhase;
              }
            }

            let drawEl = null;
            if (c.kind === "image") {
              drawEl = getMediaEl(c, "image");
            } else {
              const v = getMediaEl(c, "video");
              const speed = c.speed || 1;
              const srcTime = clamp(c.inPoint + (time - c.start) * speed, 0, c.sourceDuration);
              const wasActive = activeIdsPrevRef.current.has(c.id);
              const seekThreshold = isPlaying ? 0.35 : 0.03;
              if (!wasActive || Math.abs(v.currentTime - srcTime) > seekThreshold) {
                try { v.currentTime = srcTime; } catch (e) {}
              }
              v.playbackRate = clamp(speed, 0.1, 4);
              const wantAudio = isPlaying && !muted && c.audioEnabled && overlapCount === 1;
              if (wantAudio) {
                v.muted = false;
                v.volume = clamp((c.volume ?? 100) / 100, 0, 1);
                if (v.paused) v.play().catch(() => {});
              } else {
                v.muted = true;
                if (isPlaying && v.paused) v.play().catch(() => {});
                else if (!isPlaying && !v.paused) v.pause();
              }
              drawEl = v;
            }

            ctx.save();
            ctx.globalAlpha = clamp(alpha, 0, 1);
            const f = c.filters || {};
            ctx.filter = `brightness(${f.brightness ?? 100}%) contrast(${f.contrast ?? 100}%) saturate(${f.saturation ?? 100}%) blur(${f.blur ?? 0}px)`;
            
            let rotation = 0;
            let currentTranslateX = translateX;
            let currentScale = scale;
            if (c.motionEffect === "swing") {
              rotation = Math.sin(time * Math.PI * 2 * 0.5) * (5 * Math.PI / 180);
              currentScale *= 1.1;
            } else if (c.motionEffect === "shake") {
              currentTranslateX += (Math.random() - 0.5) * 20;
              currentScale *= 1.05;
            } else if (c.motionEffect === "pulse") {
              currentScale *= 1 + 0.1 * Math.sin(time * Math.PI * 2 * 1);
            }

            ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
            ctx.scale(currentScale, currentScale);
            if (rotation) ctx.rotate(rotation);
            ctx.translate(-CANVAS_W / 2 + currentTranslateX, -CANVAS_H / 2);
            try { if (drawEl) ctx.drawImage(drawEl, 0, 0, CANVAS_W, CANVAS_H); } catch (e) {}
            ctx.restore();
            if (f.vignette) {
              ctx.save();
              const grad = ctx.createRadialGradient(CANVAS_W / 2, CANVAS_H / 2, CANVAS_H * 0.28, CANVAS_W / 2, CANVAS_H / 2, CANVAS_H * 0.75);
              grad.addColorStop(0, "rgba(0,0,0,0)");
              grad.addColorStop(1, `rgba(0,0,0,${(f.vignette / 100) * 0.8})`);
              ctx.fillStyle = grad;
              ctx.globalAlpha = clamp(alpha, 0, 1);
              ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
              ctx.restore();
            }
          }
          for (const c of t.laid) {
            if (!(time >= c.start && time < c.end)) {
              const pooled = mediaPoolRef.current[c.id];
              if (pooled && pooled.kind !== "image" && !pooled.el.paused) pooled.el.pause();
            }
          }
        } else if (t.type === "audio") {
          const active = t.laid.filter((c) => time >= c.start && time < c.end);
          for (const c of active) {
            nextActiveIds.add(c.id);
            const a = getMediaEl(c, "audio");
            const srcTime = clamp(c.inPoint + (time - c.start), 0, c.sourceDuration);
            const wasActive = activeIdsPrevRef.current.has(c.id);
            const seekThreshold = isPlaying ? 0.35 : 0.03;
            if (!wasActive || Math.abs(a.currentTime - srcTime) > seekThreshold) {
              try { a.currentTime = srcTime; } catch (e) {}
            }
            const vol = clamp(((c.volume ?? 80) / 100) * fadeMultiplier(time, c), 0, 1);
            if (isPlaying && !muted) {
              a.muted = false;
              a.volume = vol;
              if (a.paused) a.play().catch(() => {});
            } else {
              a.muted = true;
              if (!isPlaying && !a.paused) a.pause();
            }
          }
          for (const c of t.laid) {
            if (!(time >= c.start && time < c.end)) {
              const pooled = mediaPoolRef.current[c.id];
              if (pooled && !pooled.el.paused) pooled.el.pause();
            }
          }
        } else if (t.type === "text") {
          const active = t.laid.find((c) => time >= c.start && time < c.end);
          if (active) {
            ctx.save();
            ctx.globalAlpha = fadeMultiplier(time, active);
            ctx.font = `${active.fontWeight} ${active.fontSize}px 'Segoe UI', sans-serif`;
            ctx.fillStyle = active.color;
            ctx.textAlign = active.align;
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(0,0,0,0.6)";
            ctx.shadowBlur = 8;
            ctx.fillText(active.text, active.x * CANVAS_W, active.y * CANVAS_H);
            ctx.restore();
          }
        }
      }
      activeIdsPrevRef.current = nextActiveIds;

      function getVideoElSafe(clip) {
        return getMediaEl(clip, "video");
      }
    },
    [laidOutTracks, isPlaying, muted]
  );

  useEffect(() => {
    renderFrame(currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, renderFrame]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
      return;
    }
    const loop = (ts) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setCurrentTime((t) => {
        const nt = t + dt;
        if (nt >= duration) {
          setIsPlaying(false);
          return duration;
        }
        return nt;
      });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [isPlaying, duration]);

  // ---------- timeline drag/trim ----------
  const onClipMouseDown = (e, clip, trackId, mode) => {
    e.stopPropagation();
    setSelectedClipId(clip.id);
    dragRef.current = {
      mode, clipId: clip.id, trackId, startX: e.clientX,
      origStart: clip.start, origDuration: clip.duration, origIn: clip.inPoint, origOut: clip.outPoint, speed: clip.speed || 1,
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
  };

  const onDragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaSec = (e.clientX - d.startX) / pxPerSec;
    setTracks((prev) =>
      prev.map((t) => {
        if (t.id !== d.trackId) return t;
        return {
          ...t,
          clips: t.clips.map((c) => {
            if (c.id !== d.clipId) return c;
            if (d.mode === "move") return c;
            const hasSource = c.kind === "video" || c.kind === "audio";
            if (d.mode === "trim-right") {
              const maxDur = hasSource ? (c.sourceDuration - d.origIn) / d.speed : 999;
              const newDur = clamp(d.origDuration + deltaSec, MIN_CLIP_SEC, maxDur);
              const patch = { duration: newDur };
              if (hasSource) patch.outPoint = d.origIn + newDur * d.speed;
              return { ...c, ...patch };
            }
            if (d.mode === "trim-left") {
              const maxShrink = d.origDuration - MIN_CLIP_SEC;
              const minShrink = hasSource ? -d.origIn / d.speed : -999;
              const shrink = clamp(deltaSec, minShrink, maxShrink);
              const newDur = d.origDuration - shrink;
              const patch = { duration: newDur };
              if (hasSource) patch.inPoint = clamp(d.origIn + shrink * d.speed, 0, c.sourceDuration);
              return { ...c, ...patch };
            }
            return c;
          }),
        };
      })
    );
  };

  const onDragUp = (e) => {
    const d = dragRef.current;
    if (d && d.mode === "move") {
      const deltaSec = (e.clientX - d.startX) / pxPerSec;
      if (Math.abs(deltaSec) > 0.35) {
        setTracks((prev) =>
          prev.map((t) => {
            if (t.id !== d.trackId) return t;
            const sorted = [...t.clips].sort((a, b) => a.order - b.order);
            const idx = sorted.findIndex((c) => c.id === d.clipId);
            const swapIdx = deltaSec > 0 ? idx + 1 : idx - 1;
            if (swapIdx < 0 || swapIdx >= sorted.length) return t;
            const a = sorted[idx], b = sorted[swapIdx];
            return { ...t, clips: t.clips.map((c) => (c.id === a.id ? { ...c, order: b.order } : c.id === b.id ? { ...c, order: a.order } : c)) };
          })
        );
      }
    }
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
  };

  const onTimelineClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = clamp((e.clientX - rect.left) / pxPerSec, 0, duration);
    setCurrentTime(t);
  };

  // ---------- export ----------
  const handleExport = async () => {
    setIsExporting(true);
    setExportProgress(0);
    setExportUrl(null);
    setIsPlaying(false);
    setCurrentTime(0);
    await new Promise((r) => setTimeout(r, 100));

    const canvas = canvasRef.current;
    const canvasStream = canvas.captureStream(30);

    let audioCtx = null;
    let audioDestination = null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioDestination = audioCtx.createMediaStreamDestination();
      for (const t of tracks) {
        if (t.type !== "video" && t.type !== "audio") continue;
        for (const c of t.clips) {
          if (t.type === "video" && (c.kind !== "video" || !c.audioEnabled)) continue;
          const el = getMediaEl({ ...c }, t.type === "video" ? "video" : "audio");
          if (!el._audioConnected) {
            try {
              const src = audioCtx.createMediaElementSource(el);
              const gain = audioCtx.createGain();
              gain.gain.value = (c.volume ?? 100) / 100;
              src.connect(gain).connect(audioDestination);
              el._audioConnected = true;
              el._gainNode = gain;
              mediaPoolRef.current[c.id] = mediaPoolRef.current[c.id] || { el, kind: t.type };
              mediaPoolRef.current[c.id].gainNode = gain;
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.warn("Audio export setup failed", e);
    }

    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...(audioDestination ? audioDestination.stream.getAudioTracks() : [])]);
    let mimeType = "video/webm;codecs=vp9,opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm";
    const recorder = new MediaRecorder(combined, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));

    recorder.start();
    setIsPlaying(true);
    const startTs = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - startTs) / 1000;
      setExportProgress(clamp(elapsed / duration, 0, 1));
      // keep gain nodes in sync with fades during export
      for (const t of tracks) {
        if (t.type !== "audio") continue;
        const laid = layoutTrack(t.clips);
        for (const c of laid) {
          const pooled = mediaPoolRef.current[c.id];
          if (pooled && pooled.gainNode) {
            const active = elapsed >= c.start && elapsed < c.end;
            pooled.gainNode.gain.value = active ? clamp(((c.volume ?? 80) / 100) * fadeMultiplier(elapsed, c), 0, 1) : 0;
          }
        }
      }
      if (elapsed >= duration) {
        recorder.stop();
        setIsPlaying(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    await done;
    const blob = new Blob(chunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    setExportUrl(url);
    setIsExporting(false);
    setExportProgress(1);
    if (audioCtx) audioCtx.close().catch(() => {});
  };

  const videoLib = library.filter((m) => m.kind === "video");
  const audioLib = library.filter((m) => m.kind === "audio");
  const imageLib = library.filter((m) => m.kind === "image");

  // ---------- UI ----------
  return (
    <div style={styles.app}>
      <style>{`
        * { box-sizing: border-box; }
        input[type=range] { accent-color: #7c5cff; }
        ::-webkit-scrollbar { height: 10px; width: 10px; }
        ::-webkit-scrollbar-thumb { background: #3a3a44; border-radius: 6px; }
        ::-webkit-scrollbar-track { background: #1a1a20; }
        .preset-btn { transition: transform .1s ease; }
        .preset-btn:active { transform: scale(0.95); }
      `}</style>

      <div style={styles.topbar}>
        <div style={styles.logo}><Film size={18} color="#7c5cff" /><span>Vidly — trình chỉnh sửa video</span></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {exportUrl && (
            <a href={exportUrl} download="video-xuat.webm" style={styles.downloadLink}><Download size={14} /> Tải video đã xuất</a>
          )}
          <button style={styles.exportBtn} onClick={handleExport} disabled={isExporting}>
            {isExporting ? `Đang xuất ${(exportProgress * 100).toFixed(0)}%` : (<><Download size={14} /> Xuất video</>)}
          </button>
        </div>
      </div>

      <div style={styles.mainRow}>
        <div style={styles.leftPanel}>
          <div style={styles.panelTitle}>Thư viện</div>
          <button style={styles.uploadBtn} onClick={() => videoFileInputRef.current.click()}><Upload size={14} /> Nhập video</button>
          <input ref={videoFileInputRef} type="file" accept="video/*" multiple style={{ display: "none" }} onChange={(e) => handleVideoFiles(e.target.files)} />
          <button style={{ ...styles.uploadBtn, marginTop: 8 }} onClick={() => audioFileInputRef.current.click()}><Music size={14} /> Nhập nhạc</button>
          <input ref={audioFileInputRef} type="file" accept="audio/*" multiple style={{ display: "none" }} onChange={(e) => handleAudioFiles(e.target.files)} />
          <button style={{ ...styles.uploadBtn, marginTop: 8 }} onClick={() => imageFileInputRef.current.click()}><ImageIcon size={14} /> Nhập hình ảnh</button>
          <input ref={imageFileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => handleImageFiles(e.target.files)} />
          <button style={styles.uploadBtnAlt} onClick={addTextClip}><Type size={14} /> Thêm chữ vào timeline</button>

          {videoLib.length > 0 && <div style={styles.groupLabel}>Video</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {videoLib.map((m) => (
              <div key={m.id} style={styles.mediaItem}>
                <div style={styles.mediaThumb}><Film size={16} color="#8b8b96" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.mediaName}>{m.name}</div>
                  <div style={styles.mediaMeta}>{fmtTime(m.duration)}</div>
                </div>
                <button style={styles.addToTrackBtn} onClick={() => addClipToTrack(tracks.find((t) => t.type === "video").id, m)} title="Thêm vào timeline"><Plus size={14} /></button>
              </div>
            ))}
          </div>

          {audioLib.length > 0 && <div style={styles.groupLabel}>Nhạc</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {audioLib.map((m) => (
              <div key={m.id} style={styles.mediaItem}>
                <div style={styles.mediaThumb}><Music size={16} color="#8b8b96" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.mediaName}>{m.name}</div>
                  <div style={styles.mediaMeta}>{fmtTime(m.duration)}</div>
                </div>
                <button style={styles.addToTrackBtn} onClick={() => addClipToTrack(tracks.find((t) => t.type === "audio").id, m)} title="Thêm vào timeline"><Plus size={14} /></button>
              </div>
            ))}
          </div>

          {imageLib.length > 0 && <div style={styles.groupLabel}>Hình ảnh</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {imageLib.map((m) => (
              <div key={m.id} style={styles.mediaItem}>
                <div style={styles.mediaThumb}>
                  <img src={m.url} alt={m.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.mediaName}>{m.name}</div>
                  <div style={styles.mediaMeta}>Ảnh tĩnh</div>
                </div>
                <button style={styles.addToTrackBtn} onClick={() => addClipToTrack(tracks.find((t) => t.type === "video").id, m)} title="Thêm vào timeline"><Plus size={14} /></button>
              </div>
            ))}
          </div>

          {library.length === 0 && <div style={styles.emptyHint}>Chưa có gì cả. Nhập video, ảnh hoặc nhạc để bắt đầu.</div>}
        </div>

        <div style={styles.centerPanel}>
          <div style={styles.previewWrap}><canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={styles.canvas} /></div>
          <div style={styles.transportBar}>
            <button style={styles.iconBtn} onClick={() => setIsPlaying((p) => !p)}>{isPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
            <button style={styles.iconBtn} onClick={() => setMuted((m) => !m)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
            <div style={styles.timeReadout}>{fmtTime(currentTime)} / {fmtTime(duration)}</div>
            <button style={styles.iconBtn} onClick={() => selectedClip && (selectedClip.trackType === "video" || selectedClip.trackType === "audio") && splitClipAt(selectedClip.id, currentTime)} title="Cắt clip tại vị trí phát"><Scissors size={16} /></button>
            {selectedClip && <button style={styles.iconBtnDanger} onClick={() => deleteClip(selectedClip.id)} title="Xoá clip"><Trash2 size={16} /></button>}
          </div>
        </div>

        <div style={styles.rightPanel}>
          <div style={styles.panelTitle}>Thuộc tính</div>
          {!selectedClip && <div style={styles.emptyHint}>Chọn 1 clip trên timeline để chỉnh sửa.</div>}

          {selectedClip && selectedClip.trackType === "video" && (selectedClip.kind === "video" || selectedClip.kind === "image") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={styles.fieldLabel}>Hiệu ứng nhanh</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {Object.keys(EFFECT_PRESETS).map((p) => (
                    <button key={p} className="preset-btn" onClick={() => applyPreset(selectedClip.id, p)}
                      style={{ ...styles.presetChip, background: selectedClip.preset === p ? "#7c5cff" : "#1d1d26" }}>
                      {presetLabel(p)}
                    </button>
                  ))}
                </div>
              </div>
              <Slider label="Độ sáng" value={selectedClip.filters.brightness} min={0} max={200} onChange={(v) => updateClip(selectedClip.id, { filters: { ...selectedClip.filters, brightness: v }, preset: "custom" })} />
              <Slider label="Độ tương phản" value={selectedClip.filters.contrast} min={0} max={200} onChange={(v) => updateClip(selectedClip.id, { filters: { ...selectedClip.filters, contrast: v }, preset: "custom" })} />
              <Slider label="Độ bão hoà" value={selectedClip.filters.saturation} min={0} max={200} onChange={(v) => updateClip(selectedClip.id, { filters: { ...selectedClip.filters, saturation: v }, preset: "custom" })} />
              <Slider label="Làm mờ (blur)" value={selectedClip.filters.blur ?? 0} min={0} max={20} onChange={(v) => updateClip(selectedClip.id, { filters: { ...selectedClip.filters, blur: v }, preset: "custom" })} />
              <Slider label="Viền tối (vignette)" value={selectedClip.filters.vignette ?? 0} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { filters: { ...selectedClip.filters, vignette: v }, preset: "custom" })} />
              <Slider label="Độ mờ toàn clip (opacity)" value={selectedClip.opacity} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { opacity: v })} />

              <div>
                <div style={styles.fieldLabel}>Hiệu ứng chuyển động (Animation)</div>
                <select value={selectedClip.motionEffect || "none"} onChange={(e) => updateClip(selectedClip.id, { motionEffect: e.target.value })} style={styles.select}>
                  <option value="none">Không có</option>
                  <option value="swing">Đung đưa (swing)</option>
                  <option value="shake">Rung lắc (shake)</option>
                  <option value="pulse">Nhịp đập (pulse)</option>
                </select>
              </div>

              {selectedClip.kind === "video" && (
                <div>
                  <div style={styles.fieldLabel}>Tốc độ phát</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    {SPEED_PRESETS.map((s) => (
                      <button key={s} className="preset-btn" onClick={() => updateClip(selectedClip.id, { speed: s, duration: (selectedClip.outPoint - selectedClip.inPoint) / s })}
                        style={{ ...styles.presetChip, background: selectedClip.speed === s ? "#7c5cff" : "#1d1d26" }}>{s}x</button>
                    ))}
                  </div>
                </div>
              )}

              {selectedClip.kind === "image" && (
                <Slider label="Thời lượng hiển thị (giây x10)" value={Math.round(selectedClip.duration * 10)} min={5} max={300} onChange={(v) => updateClip(selectedClip.id, { duration: v / 10 })} />
              )}

              <div>
                <div style={styles.fieldLabel}>Chuyển cảnh sang clip kế</div>
                <select value={selectedClip.transitionType} onChange={(e) => updateClip(selectedClip.id, { transitionType: e.target.value })} style={styles.select}>
                  <option value="crossfade">Hoà tan (crossfade)</option>
                  <option value="slide">Trượt (push)</option>
                  <option value="zoom">Phóng to (zoom)</option>
                  <option value="strobe">Giật chớp (strobe)</option>
                </select>
                <Slider label="Thời lượng chuyển cảnh (giây)" value={Math.round((selectedClip.transitionOutDuration || 0) * 10)} min={0} max={20} onChange={(v) => updateClip(selectedClip.id, { transitionOutDuration: v / 10 })} />
              </div>

              {selectedClip.kind === "video" && (
                <>
                  <label style={styles.checkboxRow}><input type="checkbox" checked={selectedClip.audioEnabled} onChange={(e) => updateClip(selectedClip.id, { audioEnabled: e.target.checked })} /> Bật âm thanh gốc</label>
                  {selectedClip.audioEnabled && <Slider label="Âm lượng gốc" value={selectedClip.volume ?? 100} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { volume: v })} />}
                </>
              )}
            </div>
          )}

          {selectedClip && selectedClip.trackType === "audio" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Slider label="Âm lượng" value={selectedClip.volume} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { volume: v })} />
              <Slider label="Fade in (giây x10)" value={Math.round(selectedClip.fadeIn * 10)} min={0} max={30} onChange={(v) => updateClip(selectedClip.id, { fadeIn: v / 10 })} />
              <Slider label="Fade out (giây x10)" value={Math.round(selectedClip.fadeOut * 10)} min={0} max={30} onChange={(v) => updateClip(selectedClip.id, { fadeOut: v / 10 })} />
            </div>
          )}

          {selectedClip && selectedClip.trackType === "text" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={styles.fieldLabel}>Nội dung</label>
              <textarea value={selectedClip.text} onChange={(e) => updateClip(selectedClip.id, { text: e.target.value })} style={styles.textArea} />
              <Slider label="Cỡ chữ" value={selectedClip.fontSize} min={12} max={120} onChange={(v) => updateClip(selectedClip.id, { fontSize: v })} />
              <Slider label="Vị trí ngang" value={Math.round(selectedClip.x * 100)} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { x: v / 100 })} />
              <Slider label="Vị trí dọc" value={Math.round(selectedClip.y * 100)} min={0} max={100} onChange={(v) => updateClip(selectedClip.id, { y: v / 100 })} />
              <label style={styles.fieldLabel}>Màu chữ</label>
              <input type="color" value={selectedClip.color} onChange={(e) => updateClip(selectedClip.id, { color: e.target.value })} style={{ width: 60, height: 30 }} />
              <Slider label="Thời lượng hiển thị (giây x10)" value={Math.round(selectedClip.duration * 10)} min={5} max={200} onChange={(v) => updateClip(selectedClip.id, { duration: v / 10 })} />
            </div>
          )}
        </div>
      </div>

      <div style={styles.timelinePanel}>
        <div style={styles.timelineToolbar}>
          <span style={{ color: "#8b8b96", fontSize: 12 }}>Timeline</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button style={styles.iconBtnSmall} onClick={() => setZoom((z) => clamp(z - 0.25, 0.25, 4))}><ZoomOut size={13} /></button>
            <span style={{ fontSize: 11, color: "#8b8b96", width: 36, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
            <button style={styles.iconBtnSmall} onClick={() => setZoom((z) => clamp(z + 0.25, 0.25, 4))}><ZoomIn size={13} /></button>
          </div>
        </div>
        <div style={styles.timelineScroll} onClick={onTimelineClick}>
          <div style={{ position: "relative", width: Math.max(600, duration * pxPerSec + 200) }}>
            <div style={styles.ruler}>
              {Array.from({ length: Math.ceil(duration) + 1 }).map((_, i) => (
                <div key={i} style={{ position: "absolute", left: i * pxPerSec, top: 0, height: "100%" }}>
                  <div style={styles.rulerTick} />
                  <div style={styles.rulerLabel}>{fmtTime(i)}</div>
                </div>
              ))}
            </div>
            {laidOutTracks.map((t) => (
              <div key={t.id} style={{ ...styles.trackRow, background: t.type === "text" ? "#20161f" : t.type === "audio" ? "#132018" : "#17171d" }}>
                <div style={styles.trackLabel}>{t.name}</div>
                {t.laid.map((c) => (
                  <div key={c.id} onMouseDown={(e) => onClipMouseDown(e, c, t.id, "move")}
                    style={{
                      ...styles.clip, left: c.start * pxPerSec, width: Math.max(4, c.duration * pxPerSec),
                      background: t.type === "text" ? "#5b3a8f" : t.type === "audio" ? "#2f8f5b" : c.kind === "image" ? "#8f6a2f" : selectedClipId === c.id ? "#7c5cff" : "#3d3d8f",
                      outline: selectedClipId === c.id ? "2px solid #b3a1ff" : "none",
                    }}>
                    {t.type !== "text" && <div style={styles.trimHandleLeft} onMouseDown={(e) => onClipMouseDown(e, c, t.id, "trim-left")} />}
                    <div style={styles.clipLabel}>{t.type === "text" ? c.text : t.type === "audio" ? "🎵 Nhạc" : c.kind === "image" ? "🖼 Ảnh" : "Video"}</div>
                    {t.type !== "text" && <div style={styles.trimHandleRight} onMouseDown={(e) => onClipMouseDown(e, c, t.id, "trim-right")} />}
                  </div>
                ))}
              </div>
            ))}
            <div style={{ ...styles.playhead, left: currentTime * pxPerSec }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function presetLabel(p) {
  const map = { none: "Gốc", warm: "Ấm", cool: "Lạnh", mono: "Đen trắng", vintage: "Cổ điển", dramatic: "Kịch tính", dreamy: "Mộng mơ", custom: "Tuỳ chỉnh" };
  return map[p] || p;
}

function Slider({ label, value, min, max, onChange }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#c7c7d1", marginBottom: 4 }}>
        <span>{label}</span><span>{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%" }} />
    </div>
  );
}

const styles = {
  app: { display: "flex", flexDirection: "column", height: "100vh", minHeight: 640, background: "#0e0e12", color: "#e8e8ee", fontFamily: "'Segoe UI', Roboto, sans-serif" },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #232329", background: "#131318" },
  logo: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14, letterSpacing: 0.3 },
  exportBtn: { display: "flex", alignItems: "center", gap: 6, background: "#7c5cff", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  downloadLink: { display: "flex", alignItems: "center", gap: 6, color: "#8effc1", fontSize: 13, textDecoration: "none", border: "1px solid #2a5c3f", padding: "8px 12px", borderRadius: 8 },
  mainRow: { display: "flex", flex: 1, minHeight: 0 },
  leftPanel: { width: 230, borderRight: "1px solid #232329", padding: 12, overflowY: "auto", background: "#111116" },
  rightPanel: { width: 280, borderLeft: "1px solid #232329", padding: 12, overflowY: "auto", background: "#111116" },
  panelTitle: { fontSize: 12, color: "#8b8b96", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  groupLabel: { fontSize: 11, color: "#63636e", margin: "10px 0 4px" },
  uploadBtn: { display: "flex", alignItems: "center", gap: 6, justifyContent: "center", width: "100%", padding: "9px 10px", background: "#1d1d26", border: "1px solid #2f2f3a", borderRadius: 8, color: "#e8e8ee", cursor: "pointer", fontSize: 13 },
  uploadBtnAlt: { display: "flex", alignItems: "center", gap: 6, justifyContent: "center", width: "100%", padding: "9px 10px", marginTop: 8, background: "transparent", border: "1px dashed #3a3a46", borderRadius: 8, color: "#c7c7d1", cursor: "pointer", fontSize: 13 },
  mediaItem: { display: "flex", alignItems: "center", gap: 8, background: "#181820", padding: 8, borderRadius: 8, border: "1px solid #24242c" },
  mediaThumb: { width: 36, height: 36, borderRadius: 6, background: "#20202a", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  mediaName: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  mediaMeta: { fontSize: 11, color: "#8b8b96" },
  addToTrackBtn: { background: "#2a2a36", border: "none", borderRadius: 6, color: "#fff", width: 26, height: 26, cursor: "pointer" },
  emptyHint: { fontSize: 12, color: "#63636e", lineHeight: 1.5 },
  centerPanel: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, minWidth: 0 },
  previewWrap: { width: "100%", maxWidth: 860, aspectRatio: "16/9", background: "#000", borderRadius: 10, overflow: "hidden", boxShadow: "0 8px 30px rgba(0,0,0,0.5)" },
  canvas: { width: "100%", height: "100%", display: "block" },
  transportBar: { display: "flex", alignItems: "center", gap: 10, marginTop: 12 },
  iconBtn: { background: "#1d1d26", border: "1px solid #2f2f3a", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", color: "#e8e8ee", cursor: "pointer" },
  iconBtnDanger: { background: "#2a1519", border: "1px solid #4a2028", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", color: "#ff8080", cursor: "pointer" },
  iconBtnSmall: { background: "#1d1d26", border: "1px solid #2f2f3a", borderRadius: 6, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", color: "#e8e8ee", cursor: "pointer" },
  timeReadout: { fontSize: 12, color: "#c7c7d1", fontVariantNumeric: "tabular-nums", minWidth: 110 },
  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#c7c7d1" },
  fieldLabel: { fontSize: 12, color: "#8b8b96" },
  textArea: { width: "100%", minHeight: 60, background: "#181820", border: "1px solid #2f2f3a", borderRadius: 8, color: "#e8e8ee", padding: 8, fontSize: 13, resize: "vertical" },
  select: { width: "100%", background: "#181820", border: "1px solid #2f2f3a", borderRadius: 8, color: "#e8e8ee", padding: "7px 8px", fontSize: 12, marginTop: 6 },
  presetChip: { border: "1px solid #2f2f3a", borderRadius: 20, color: "#e8e8ee", padding: "5px 12px", fontSize: 11, cursor: "pointer" },
  timelinePanel: { height: 260, borderTop: "1px solid #232329", background: "#0c0c10", display: "flex", flexDirection: "column" },
  timelineToolbar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", borderBottom: "1px solid #1c1c22" },
  timelineScroll: { flex: 1, overflow: "auto", position: "relative", padding: "0 0 10px 0" },
  ruler: { position: "relative", height: 20, borderBottom: "1px solid #1c1c22" },
  rulerTick: { width: 1, height: 8, background: "#3a3a46" },
  rulerLabel: { fontSize: 9, color: "#63636e", marginTop: 2, transform: "translateX(-50%)" },
  trackRow: { position: "relative", height: TRACK_HEIGHT, borderBottom: "1px solid #1c1c22", marginTop: 4 },
  trackLabel: { position: "absolute", left: 4, top: 4, fontSize: 10, color: "#63636e", zIndex: 1, pointerEvents: "none" },
  clip: { position: "absolute", top: 6, height: TRACK_HEIGHT - 12, borderRadius: 6, cursor: "grab", display: "flex", alignItems: "center", overflow: "hidden", userSelect: "none" },
  clipLabel: { fontSize: 11, color: "#fff", padding: "0 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none" },
  trimHandleLeft: { position: "absolute", left: 0, top: 0, width: 8, height: "100%", background: "rgba(255,255,255,0.25)", cursor: "ew-resize" },
  trimHandleRight: { position: "absolute", right: 0, top: 0, width: 8, height: "100%", background: "rgba(255,255,255,0.25)", cursor: "ew-resize" },
  playhead: { position: "absolute", top: 0, bottom: 0, width: 2, background: "#ff5c7c", zIndex: 5, pointerEvents: "none" },
};
