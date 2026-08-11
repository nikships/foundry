{
  "targets": [
    {
      "target_name": "ghostty_renderer",
      "sources": ["src/addon.c"],
      "include_dirs": ["../../vendor/ghostty/include"],
      "conditions": [
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/../../vendor/ghostty/zig-out/lib/libghostty.a",
            "-lc++",
            "-framework AppKit",
            "-framework Carbon",
            "-framework CoreFoundation",
            "-framework CoreGraphics",
            "-framework CoreText",
            "-framework CoreVideo",
            "-framework IOSurface",
            "-framework Metal",
            "-framework MetalKit",
            "-framework QuartzCore"
          ],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "13.0"
          }
        }]
      ]
    }
  ]
}
