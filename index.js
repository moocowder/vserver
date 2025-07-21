const express = require("express")
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const { spawn } = require("child_process")
const cors = require("cors")

const app = express()

//stupid commit
// Railway provides PORT automatically, fallback for local development
const PORT = process.env.PORT || 3000

// CORS configuration - Updated for Railway
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173", // Vite default
    "http://localhost:5174", // Vite alternative
    "https://claude.ai", // Claude artifacts
    // Railway provides RAILWAY_STATIC_URL for your deployed domain
    process.env.RAILWAY_STATIC_URL,
    // You can also add your custom Railway domain here
    "https://vserver.up.railway.app",
    "https://vserver-production-029d.up.railway.app",
    "https://hosteelapp.vercel.app",
  ].filter(Boolean), // Remove undefined values
  credentials: true,
  optionsSuccessStatus: 200,
}

// Apply CORS middleware
app.use(cors(corsOptions))

// Create directories using Railway volume mount or local fallback
const MOUNT_PATH =
  process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data")
const UPLOAD_DIR = path.join(MOUNT_PATH, "uploads")
const CHUNKS_DIR = path.join(UPLOAD_DIR, "chunks")
const TEMP_DIR = path.join(CHUNKS_DIR, "temp")
const FINAL_DIR = path.join(UPLOAD_DIR, "final")

// Create directories with error handling
const directories = [UPLOAD_DIR, CHUNKS_DIR, TEMP_DIR, FINAL_DIR]
directories.forEach((dir) => {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`Created directory: ${dir}`)
    }
  } catch (error) {
    console.error(`Failed to create directory ${dir}:`, error)
    // For Railway, this might indicate volume mounting issues
    if (process.env.RAILWAY_ENVIRONMENT) {
      console.error("Railway volume might not be properly mounted")
    }
  }
})

// Configure multer for file uploads - store temporarily first
const upload = multer({
  dest: path.join(CHUNKS_DIR, "temp"),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per chunk
  },
})

// Middleware
app.use(express.json())
app.use(express.static("public")) // Serve the HTML file from public directory

// Store recording sessions
const sessions = new Map()

// Upload chunk endpoint
app.post("/upload-chunk", upload.single("chunk"), (req, res) => {
  try {
    const { sessionId, chunkIndex } = req.body

    if (!sessionId || chunkIndex === undefined) {
      return res.status(400).json({ error: "Missing sessionId or chunkIndex" })
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" })
    }

    // Create session directory
    const sessionDir = path.join(CHUNKS_DIR, sessionId)
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true })
    }

    // Move file from temp to proper location
    const chunkIndex_padded = chunkIndex.padStart(4, "0")
    const finalPath = path.join(sessionDir, `chunk_${chunkIndex_padded}.webm`)
    fs.renameSync(req.file.path, finalPath)

    console.log(
      `Received chunk ${chunkIndex} for session ${sessionId}, size: ${req.file.size} bytes`
    )

    // Track chunks for this session
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        chunks: [],
        startTime: Date.now(),
      })
    }

    const session = sessions.get(sessionId)
    session.chunks.push(parseInt(chunkIndex))

    res.json({
      success: true,
      message: `Chunk ${chunkIndex} received`,
      totalChunks: session.chunks.length,
    })
  } catch (error) {
    console.error("Error handling chunk upload:", error)
    res.status(500).json({ error: "Failed to process chunk" })
  }
})

// Finalize recording endpoint
app.post("/finalize-recording", async (req, res) => {
  const { sessionId, totalChunks } = req.body

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId" })
  }

  console.log(
    `Finalizing recording for session ${sessionId}, expected ${totalChunks} chunks`
  )

  try {
    await combineChunks(sessionId, totalChunks)

    // Clean up chunks after successful combination
    const sessionChunksDir = path.join(CHUNKS_DIR, sessionId)
    if (fs.existsSync(sessionChunksDir)) {
      fs.rmSync(sessionChunksDir, { recursive: true })
    }

    sessions.delete(sessionId)

    // Generate a unique video ID (you can use UUID or timestamp-based)
    const videoId = `video_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`

    res.json({
      success: true,
      message: "Recording finalized",
      videoId: sessionId,
      sessionId: sessionId,
      videoPath: `/video/${sessionId}.webm`,
    })
  } catch (error) {
    console.error("Error finalizing recording:", error)
    res.status(500).json({ error: "Failed to finalize recording" })
  }
})

// Combine chunks into final video
async function combineChunks(sessionId, expectedChunks) {
  return new Promise((resolve, reject) => {
    const sessionChunksDir = path.join(CHUNKS_DIR, sessionId)
    const outputPath = path.join(FINAL_DIR, `${sessionId}.webm`)

    // Create list of chunk files
    const chunkFiles = []
    for (let i = 0; i < expectedChunks; i++) {
      const chunkFile = path.join(
        sessionChunksDir,
        `chunk_${i.toString().padStart(4, "0")}.webm`
      )
      if (fs.existsSync(chunkFile)) {
        chunkFiles.push(chunkFile)
      }
    }

    if (chunkFiles.length === 0) {
      return reject(new Error("No chunks found"))
    }

    // Simple concatenation for WebM files
    const outputStream = fs.createWriteStream(outputPath)
    let currentIndex = 0

    function appendNextChunk() {
      if (currentIndex >= chunkFiles.length) {
        outputStream.end()
        resolve()
        return
      }

      const chunkPath = chunkFiles[currentIndex]
      const chunkStream = fs.createReadStream(chunkPath)

      chunkStream.on("end", () => {
        currentIndex++
        appendNextChunk()
      })

      chunkStream.on("error", reject)
      chunkStream.pipe(outputStream, { end: false })
    }

    appendNextChunk()
  })
}

// Serve recorded videos
app.get("/video/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId.replace(".webm", "")
  const videoPath = path.join(FINAL_DIR, `${sessionId}.webm`)

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: "Video not found" })
  }

  const stat = fs.statSync(videoPath)
  const fileSize = stat.size
  const range = req.headers.range

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-")
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunksize = end - start + 1
    const file = fs.createReadStream(videoPath, { start, end })
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/webm",
    }
    res.writeHead(206, head)
    file.pipe(res)
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/webm",
    }
    res.writeHead(200, head)
    fs.createReadStream(videoPath).pipe(res)
  }
})

// List all recordings
app.get("/recordings", (req, res) => {
  try {
    const files = fs
      .readdirSync(FINAL_DIR)
      .filter((file) => file.endsWith(".webm"))
      .map((file) => {
        const sessionId = file.replace(".webm", "")
        const filePath = path.join(FINAL_DIR, file)
        const stats = fs.statSync(filePath)

        return {
          sessionId,
          filename: file,
          size: stats.size,
          created: stats.birthtime,
          url: `/video/${sessionId}`,
        }
      })

    res.json(files)
  } catch (error) {
    console.error("Error listing recordings:", error)
    res.status(500).json({ error: "Failed to list recordings" })
  }
})

// Health check - includes Railway environment info
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    activeSessions: sessions.size,
    timestamp: new Date().toISOString(),
    environment: process.env.RAILWAY_ENVIRONMENT || "local",
    mountPath: MOUNT_PATH,
    // Show disk usage if on Railway
    storage: process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? "Railway Volume"
      : "Local Filesystem",
  })
})

// Listen on 0.0.0.0 for Railway (required for external access)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`Environment: ${process.env.RAILWAY_ENVIRONMENT || "local"}`)
  console.log(`Mount path: ${MOUNT_PATH}`)
  console.log(`Upload directory: ${UPLOAD_DIR}`)
  console.log(`Final videos directory: ${FINAL_DIR}`)

  // Railway-specific logging
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log("Running on Railway!")
    console.log(
      `Railway URL: ${process.env.RAILWAY_STATIC_URL || "Not available"}`
    )
  }
})

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down gracefully...")
  process.exit(0)
})

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...")
  process.exit(0)
})
