const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const os = require("os");

/**
 * Local development server for testing providers
 */
class DevServer {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 7860;
    this.distDir = path.join(__dirname, "dist");
    this.currentDir = path.join(__dirname);

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Enable CORS for mobile app
    this.app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      })
    );

    // Serve static files from dist directory
    this.app.use("/dist", express.static(this.distDir));

    // JSON parsing
    this.app.use(express.json());

    // Logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
      next();
    });
  }

  setupRoutes() {
    // Serve manifest.json
    this.app.get("/manifest.json", (req, res) => {
      const manifestPath = path.join(this.currentDir, "manifest.json");
      console.log(`Serving manifest from: ${manifestPath}`);

      if (fs.existsSync(manifestPath)) {
        res.sendFile(manifestPath);
      } else {
        res.status(404).json({ error: "Manifest not found. Run build first." });
      }
    });

    // Serve individual provider files as JSON (BACKEND FIX)
    this.app.get("/dist/:provider/:file", async (req, res) => {
      const { provider, file } = req.params;
      let filePath = path.join(this.distDir, provider, file);

      // Check if file exists, if not try adding .js extension
      if (!fs.existsSync(filePath) && !filePath.endsWith(".js")) {
        if (fs.existsSync(filePath + ".js")) {
          filePath += ".js";
        }
      }

      if (fs.existsSync(filePath)) {
        // If it's a JS file, require it and send as JSON
        if (filePath.endsWith('.js')) {
            try {
                // Clear require cache to ensure fresh data if file changed
                delete require.cache[require.resolve(filePath)];
                const moduleData = require(filePath);
                
                // If it's the catalog file, we specifically might want the 'catalog' export
                // But generally sending the whole export object is safer
                res.json(moduleData);
            } catch (err) {
                console.error(`Error requiring file: ${filePath}`, err);
                res.status(500).json({ error: "Failed to load module", details: err.message });
            }
        } else {
            // Fallback for non-js files (e.g. source maps)
            res.sendFile(filePath);
        }
      } else {
        console.error(`File not found: ${filePath}`);
        res.status(404).json({
          error: `File not found: ${provider}/${file}`,
          hint: "Make sure to run build first",
        });
      }
    });
    
    // Dynamic Execution Route (Optional but recommended for robust API behavior)
    // This allows calls like /netflixMirror/catalog or /netflixMirror/posts?page=1
    this.app.get("/:provider/:functionName", async (req, res) => {
        const { provider, functionName } = req.params;
        
        // Skip reserved routes
        if (['manifest.json', 'dist', 'build', 'status', 'providers', 'health'].includes(provider)) {
            return res.status(404).json({ error: "Not found" });
        }

        let filePath = path.join(this.distDir, provider, functionName + ".js");
        
        // Fallback for 'watch' -> 'stream.js'
        if (!fs.existsSync(filePath)) {
             if (functionName === 'watch') {
                 filePath = path.join(this.distDir, provider, "stream.js");
             } else {
                 // If the file doesn't exist, maybe it's just missing
                 return res.status(404).json({ error: `Function ${functionName} not found for ${provider}` });
             }
        }
        
        try {
            delete require.cache[require.resolve(filePath)];
            const module = require(filePath);
            
            // Get the exported function/object
            // Priority: Named export matching filename > 'default' export > First export found
            let func = module[functionName] || module.default || Object.values(module)[0];
            
            // Special handling for 'watch' mapping to 'stream' export
            if (functionName === 'watch') {
                func = module['stream'] || module.default;
            }

            if (typeof func !== 'function') {
                // If it's data (like catalog array), return it directly
                return res.json(func);
            }
            
            // Mock Provider Context
            const providerContext = {
                url: "https://example.com", 
                // Add any other context needed by your providers
            };

            let result;
            if (functionName === 'posts') {
                const page = req.query.page || 1;
                const filter = req.query.filter || "";
                result = await func(filter, page, providerContext);
            } else if (functionName === 'search') {
                const query = req.query.query || req.params.query;
                const page = req.query.page || 1;
                result = await func(query, page, providerContext);
            } else if (functionName === 'stream' || functionName === 'watch') {
                const id = req.query.id || req.query.link;
                const type = req.query.type || "";
                result = await func(id, type, providerContext);
            } else if (functionName === 'catalog') {
                result = await func(providerContext);
            } else if (functionName === 'meta') {
                const link = req.query.link;
                result = await func(link, providerContext);
            } else if (functionName === 'episodes') {
                const link = req.query.url || req.query.link;
                result = await func(link, providerContext);
            } else {
                 // Generic execution with context only
                 result = await func(providerContext);
            }
            
            res.json(result);

        } catch (error) {
            console.error(`Execution error for ${provider}/${functionName}:`, error);
            res.status(500).json({ error: error.message, stack: error.stack });
        }
    });

    // Handle search as path param: /:provider/search/:query
    this.app.get("/:provider/search/:query", async (req, res) => {
        // Forward logic to the main handler manually to avoid code duplication
        // In a real app, I'd refactor the logic into a helper function.
        // For now, let's just use the query param redirection if the client supports it,
        // or implement minimal logic here.
        req.query.query = req.params.query;
        // ... (Logic would be repeated here, simpler to rely on the generic handler above if client uses ?query=)
        // But since we added this route specifically:
        const { provider, query } = req.params;
        // ... implement search logic or redirect ...
        res.redirect(`/${provider}/search?query=${encodeURIComponent(query)}`);
    });


    // Build endpoint - trigger rebuild
    this.app.post("/build", (req, res) => {
      try {
        console.log("🔨 Triggering rebuild...");
        execSync("node build.js", { stdio: "inherit" });
        res.json({ success: true, message: "Build completed" });
      } catch (error) {
        console.error("Build failed:", error);
        res.status(500).json({
          success: false,
          error: error.message,
        });
      }
    });

    // Status endpoint
    this.app.get("/status", (req, res) => {
      const providers = this.getAvailableProviders();
      res.json({
        status: "running",
        port: this.port,
        providers: providers.length,
        providerList: providers,
        buildTime: this.getBuildTime(),
      });
    });

    // List available providers
    this.app.get("/providers", (req, res) => {
      const providers = this.getAvailableProviders();
      res.json(providers);
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: "Not found",
        availableEndpoints: [
          "GET /manifest.json",
          "GET /dist/:provider/:file",
          "GET /:provider/:function (execute)",
          "POST /build",
          "GET /status",
          "GET /providers",
          "GET /health",
        ],
      });
    });
  }

  getAvailableProviders() {
    if (!fs.existsSync(this.distDir)) {
      return [];
    }

    return fs
      .readdirSync(this.distDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  }

  getBuildTime() {
    const manifestPath = path.join(this.currentDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const stats = fs.statSync(manifestPath);
      return stats.mtime.toISOString();
    }
    return null;
  }

  start() {
    // Get local IP address
    const interfaces = os.networkInterfaces();
    let localIp = "localhost";
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
      if (localIp !== "localhost") break;
    }
    this.app.listen(this.port, "0.0.0.0", () => {
      console.log(`
🚀 Vega Providers Dev Server Started!

📡 Server URL: http://localhost:${this.port}
📱 Mobile Test URL: http://${localIp}:${this.port}

💡 Usage:
  1. Run 'npm run auto' to to start the dev server ☑️
  2. Update vega app to use: http://${localIp}:${this.port}
  3. Test your providers!

🔄 Auto-rebuild: POST to /build to rebuild after changes
      `);

      // Check if build exists
      if (!fs.existsSync(this.distDir)) {
        console.log('\n⚠️  No build found. Run "node build.js" first!\n');
      }
    });
  }
}

// Start the server
const server = new DevServer();
server.start();
