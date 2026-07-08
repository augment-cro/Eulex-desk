/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const Dotenv = require("dotenv-webpack");

/**
 * Production builds emit straight into the Next.js public folder so the
 * existing frontend deploy serves the taskpane bundle and manifest at:
 *
 *   <frontend-origin>/word-addin/taskpane.html
 *   <frontend-origin>/word-addin/taskpane.bundle.js
 *   <frontend-origin>/word-addin/manifest.xml
 *
 * Same-origin avoids CORS for /chat & friends. Dev builds run on
 * https://localhost:3002 with self-signed Office certs.
 */
module.exports = async (_env, options) => {
    const isDev = options.mode !== "production";
    const outDir = isDev
        ? path.resolve(__dirname, "dist")
        : path.resolve(__dirname, "../frontend/public/word-addin");

    let httpsOptions = true;
    if (isDev) {
        try {
            const devCerts = require("office-addin-dev-certs");
            httpsOptions = await devCerts.getHttpsServerOptions();
        } catch {
            console.warn(
                "[mike-addin] office-addin-dev-certs not installed or certs missing.",
                "Run `npm run install-certs` once, then restart the dev server.",
            );
        }
    }

    return {
        entry: {
            taskpane: "./src/taskpane/index.tsx",
        },
        output: {
            path: outDir,
            filename: "[name].bundle.js",
            clean: true,
            // Relative paths so the bundle works regardless of mount point
            // (taskpane lives under /word-addin/ in production).
            publicPath: "",
        },
        resolve: {
            extensions: [".tsx", ".ts", ".js", ".jsx"],
        },
        module: {
            rules: [
                {
                    test: /\.(ts|tsx|js|jsx)$/,
                    use: "babel-loader",
                    exclude: /node_modules/,
                },
                {
                    test: /\.css$/,
                    use: ["style-loader", "css-loader", "postcss-loader"],
                },
                {
                    test: /\.(png|jpg|jpeg|gif|svg|ico)$/,
                    type: "asset/resource",
                    generator: { filename: "assets/[name][ext]" },
                },
            ],
        },
        plugins: [
            // `systemvars: true` lets webpack pick up env vars (notably
            // API_BASE_URL) that are set on the build environment when
            // there is no .env file on disk — which is the case inside
            // Cloud Build, where cloudbuild.yaml exports them as `env:`.
            // Without this flag, `process.env.API_BASE_URL` is replaced
            // with `undefined` at build time, the runtime fallback
            // (`window.location.origin`) kicks in, and the add-in ends
            // up POSTing /auth/pair/redeem to the *frontend* origin
            // (which has no such route) instead of the backend.
            new Dotenv({
                path: "./.env",
                safe: false,
                silent: true,
                systemvars: true,
            }),
            new HtmlWebpackPlugin({
                filename: "taskpane.html",
                template: "./src/taskpane/index.html",
                chunks: ["taskpane"],
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: "manifest.xml",
                        to: "manifest.xml",
                        // Replace ${ADDIN_URL} placeholder in manifest with the
                        // value from .env (defaults to localhost dev URL).
                        transform(content) {
                            const url =
                                process.env.ADDIN_URL ||
                                (isDev
                                    ? "https://localhost:3002"
                                    : "https://localhost:3000");
                            return Buffer.from(
                                content
                                    .toString()
                                    .replace(/\$\{ADDIN_URL\}/g, url),
                            );
                        },
                    },
                    {
                        from: "assets",
                        to: "assets",
                        noErrorOnMissing: true,
                    },
                ],
            }),
        ],
        devServer: {
            port: 3002,
            server: { type: "https", options: httpsOptions },
            static: { directory: path.join(__dirname, "dist") },
            headers: { "Access-Control-Allow-Origin": "*" },
            hot: true,
            compress: true,
        },
        devtool: isDev ? "source-map" : false,
        mode: options.mode,
    };
};
