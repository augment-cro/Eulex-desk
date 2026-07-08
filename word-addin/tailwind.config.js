/* eslint-disable @typescript-eslint/no-require-imports */
/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./src/**/*.{html,ts,tsx,js,jsx}"],
    theme: {
        extend: {
            colors: {
                mike: {
                    50: "#f4f7ff",
                    100: "#e6edff",
                    200: "#c5d3ff",
                    300: "#9aafff",
                    400: "#6f86f5",
                    500: "#4a63dc",
                    600: "#3349b8",
                    700: "#283a96",
                    800: "#1f2d75",
                    900: "#152055",
                },
            },
            fontFamily: {
                sans: [
                    "-apple-system",
                    "BlinkMacSystemFont",
                    "'Segoe UI'",
                    "Roboto",
                    "sans-serif",
                ],
                serif: ["'EB Garamond'", "Georgia", "serif"],
            },
            // Tailwind Typography overrides — the default `prose` styles
            // assume 16px+ body text and generous margins. The Word
            // taskpane is narrow and mostly 13px text, so we squeeze
            // headers, lists, and code blocks down by ~25 % so they read
            // proportionally without rebuilding `prose-sm` from scratch.
            typography: ({ theme }) => ({
                DEFAULT: {
                    css: {
                        color: theme("colors.gray.900"),
                        maxWidth: "none",
                        h1: {
                            fontSize: "1.05rem",
                            marginTop: "0.9em",
                            marginBottom: "0.4em",
                            fontWeight: "600",
                            color: theme("colors.gray.900"),
                        },
                        h2: {
                            fontSize: "1rem",
                            marginTop: "0.85em",
                            marginBottom: "0.35em",
                            fontWeight: "600",
                            color: theme("colors.gray.900"),
                        },
                        h3: {
                            fontSize: "0.95rem",
                            marginTop: "0.7em",
                            marginBottom: "0.3em",
                            fontWeight: "600",
                            color: theme("colors.gray.800"),
                        },
                        h4: {
                            fontSize: "0.9rem",
                            marginTop: "0.6em",
                            marginBottom: "0.25em",
                            fontWeight: "600",
                            color: theme("colors.gray.800"),
                        },
                        p: {
                            marginTop: "0.45em",
                            marginBottom: "0.45em",
                            lineHeight: "1.55",
                        },
                        "ul, ol": {
                            marginTop: "0.4em",
                            marginBottom: "0.6em",
                            paddingLeft: "1.1rem",
                        },
                        "li": {
                            marginTop: "0.15em",
                            marginBottom: "0.15em",
                        },
                        "li > p": {
                            marginTop: "0.1em",
                            marginBottom: "0.1em",
                        },
                        code: {
                            fontSize: "0.85em",
                            padding: "0.1em 0.3em",
                            borderRadius: "3px",
                            backgroundColor: theme("colors.gray.100"),
                            color: theme("colors.gray.900"),
                            fontWeight: "500",
                        },
                        "code::before": { content: "none" },
                        "code::after": { content: "none" },
                        pre: {
                            fontSize: "0.8rem",
                            padding: "0.6em",
                            borderRadius: "6px",
                            backgroundColor: theme("colors.gray.50"),
                            color: theme("colors.gray.900"),
                            border: `1px solid ${theme("colors.gray.200")}`,
                            overflowX: "auto",
                        },
                        "pre code": {
                            backgroundColor: "transparent",
                            padding: 0,
                            color: "inherit",
                        },
                        blockquote: {
                            borderLeftColor: theme("colors.mike.300"),
                            borderLeftWidth: "3px",
                            paddingLeft: "0.8em",
                            color: theme("colors.gray.700"),
                            fontStyle: "normal",
                        },
                        "blockquote p::before": { content: "none" },
                        "blockquote p::after": { content: "none" },
                        a: {
                            color: theme("colors.mike.600"),
                            textDecoration: "underline",
                            textUnderlineOffset: "2px",
                        },
                        hr: {
                            marginTop: "1em",
                            marginBottom: "1em",
                            borderColor: theme("colors.gray.200"),
                        },
                        strong: {
                            color: theme("colors.gray.900"),
                            fontWeight: "600",
                        },
                    },
                },
            }),
        },
    },
    plugins: [require("@tailwindcss/typography")],
};
