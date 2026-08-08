.PHONY: web web-build web-preview dev build check typecheck lint test

# Build and serve the renderer in a plain browser (no Electron).
# Suitable for iterating on UI without the native shell.
web:
	npm --prefix apps/desktop run build:web
	npm --prefix apps/desktop run preview:web -- --open

# Just build the web bundle (out/web).
web-build:
	npm --prefix apps/desktop run build:web

# Serve the last web build without rebuilding.
web-preview:
	npm --prefix apps/desktop run preview:web -- --open

# Convenience aliases for the Electron path.
dev:
	npm --prefix apps/desktop run dev

build:
	npm --prefix apps/desktop run build

check:
	npm --prefix apps/desktop run check
