.PHONY: web web-build web-preview dev build check typecheck lint test

# Build and serve the renderer in a plain browser (no Electron).
# Suitable for iterating on UI without the native shell.
web:
	pnpm run build:web
	pnpm run preview:web -- --open

# Just build the web bundle (out/web).
web-build:
	pnpm run build:web

# Serve the last web build without rebuilding.
web-preview:
	pnpm run preview:web -- --open

# Convenience aliases for the Electron path.
dev:
	pnpm run dev

build:
	pnpm run build

check:
	pnpm run check
