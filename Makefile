.PHONY: web web-build web-preview dev build check typecheck lint test

# Build and serve the renderer in a plain browser (no Electron).
# Suitable for iterating on UI without the native shell.
web:
	npm run build:web
	npm run preview:web -- --open

# Just build the web bundle (out/web).
web-build:
	npm run build:web

# Serve the last web build without rebuilding.
web-preview:
	npm run preview:web -- --open

# Convenience aliases for the Electron path.
dev:
	npm run dev

build:
	npm run build

check:
	npm run check
