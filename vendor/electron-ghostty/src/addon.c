/**
 * N-API wrapper around ghostty's embedding API with the headless
 * platform (approach A from docs/ghostty-renderer-reuse.md).
 *
 * Ghostty owns EVERYTHING: PTY + child process, IO threads, VT
 * parsing, key/mouse encoding, selection, fonts/shaping/atlas, GPU
 * (Metal) rendering, damage tracking, and IOSurface presentation.
 * This file is only marshalling around ghostty.h:
 *
 *   init()                                      once per process
 *   create({cols?, widthPx, heightPx, scale, fontSize?, command?})
 *   tick(h)                    drain ghostty's app loop (call often)
 *   wakeupPending()            true if ghostty asked for a tick
 *   draw(h)                    force a synchronous render
 *   frame(h)  -> { handle: Buffer(IOSurfaceRef +1), width, height,
 *                  scale } | null
 *   readPixels(h) -> { width, height, data } (tests; BGRA copy)
 *   size(h)   -> { cols, rows, widthPx, heightPx, cellWidth, cellHeight }
 *   resize(h, widthPx, heightPx)      pixel size; ghostty derives grid
 *   text(h, string)                   cooked text input (typing/paste)
 *   key(h, {action, key, mods, text?, unshiftedCodepoint?})  raw key
 *   mouseButton(h, action, button, mods)
 *   mousePos(h, x, y, mods)           CSS->surface px, ghostty encodes
 *   mouseScroll(h, x, y, dx, dy)      wheel: scrollback/alt-scroll/reports
 *   processExited(h) -> bool
 *   destroy(h)                        close surface + free
 *
 * The frame's IOSurfaceRef is retained (+1) by libghostty for us; we
 * release the previous one on each frame() call.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

#include <ghostty.h>
#include <node_api.h>

#define NAPI_CALL(env, call)                                               \
  do {                                                                     \
    if ((call) != napi_ok) {                                               \
      napi_throw_error(env, NULL, #call " failed");                        \
      return NULL;                                                         \
    }                                                                      \
  } while (0)

/* ── ghostty runtime callbacks + event queue ───────────────────────────
 * The embedder is "the runtime": ghostty calls these — from its render
 * and IO threads, not the JS thread. Events are queued under a mutex
 * and drained by JS via drainEvents() on the existing present tick, so
 * no threadsafe-function machinery is needed and both engine
 * placements behave identically. */

#include <pthread.h>

typedef enum {
  EV_TITLE,           /* str = title */
  EV_PWD,             /* str = path */
  EV_BELL,            /* - */
  EV_OPEN_URL,        /* str = url */
  EV_MOUSE_SHAPE,     /* num = ghostty_action_mouse_shape_e */
  EV_CLIPBOARD_WRITE, /* str = text; num = ghostty_clipboard_e */
  EV_CLIPBOARD_READ,  /* ptr = request state for completeClipboard() */
} EventType;

typedef struct Event {
  EventType type;
  char *str;    /* owned (strdup), freed on drain */
  double num;
  void *ptr;
  struct Event *next;
} Event;

static bool g_inited = false;
static volatile bool g_wakeup = false;

typedef struct {
  ghostty_app_t app;      /* one app per session keeps lifecycle simple */
  ghostty_config_t config;
  ghostty_surface_t surface;
  void *last_surface;     /* previous frame's IOSurfaceRef */
  pthread_mutex_t ev_mu;
  Event *ev_head, *ev_tail;
} Session;

static void session_push_event(Session *s, EventType type, const char *str,
                               size_t str_len, double num, void *ptr) {
  Event *ev = calloc(1, sizeof(Event));
  if (!ev) return;
  ev->type = type;
  if (str) ev->str = str_len ? strndup(str, str_len) : strdup(str);
  ev->num = num;
  ev->ptr = ptr;
  pthread_mutex_lock(&s->ev_mu);
  if (s->ev_tail) s->ev_tail->next = ev;
  else s->ev_head = ev;
  s->ev_tail = ev;
  pthread_mutex_unlock(&s->ev_mu);
  g_wakeup = true;
}

static void cb_wakeup(void *ud) {
  (void)ud;
  g_wakeup = true;
}

static bool cb_action(ghostty_app_t app, ghostty_target_s target,
                      ghostty_action_s action) {
  (void)target;
  Session *s = ghostty_app_userdata(app);
  if (!s) return false;
  switch (action.tag) {
    case GHOSTTY_ACTION_SET_TITLE:
      session_push_event(s, EV_TITLE, action.action.set_title.title, 0, 0,
                         NULL);
      return true;
    case GHOSTTY_ACTION_PWD:
      session_push_event(s, EV_PWD, action.action.pwd.pwd, 0, 0, NULL);
      return true;
    case GHOSTTY_ACTION_RING_BELL:
      session_push_event(s, EV_BELL, NULL, 0, 0, NULL);
      return true;
    case GHOSTTY_ACTION_OPEN_URL:
      session_push_event(s, EV_OPEN_URL, action.action.open_url.url,
                         action.action.open_url.len, 0, NULL);
      return true;
    case GHOSTTY_ACTION_MOUSE_SHAPE:
      session_push_event(s, EV_MOUSE_SHAPE, NULL, 0,
                         (double)action.action.mouse_shape, NULL);
      return true;
    default:
      return false; /* unhandled; ghostty proceeds with defaults */
  }
}

/**
 * Paste request: ghostty wants the clipboard's contents. The state
 * pointer stays valid until ghostty_surface_complete_clipboard_request
 * is called (JS drains the event, reads Electron's clipboard, calls
 * completeClipboard). Returning true = "request started".
 */
static bool cb_read_clipboard(void *ud, ghostty_clipboard_e loc,
                              void *state) {
  Session *s = ud;
  (void)loc;
  if (!s) return false;
  session_push_event(s, EV_CLIPBOARD_READ, NULL, 0, 0, state);
  return true;
}

static void cb_confirm_read_clipboard(void *ud, const char *str, void *state,
                                      ghostty_clipboard_request_e req) {
  (void)ud;
  (void)str;
  (void)state;
  (void)req;
}

/** Copy (selection copy, OSC 52): ship the text to JS. */
static void cb_write_clipboard(void *ud, ghostty_clipboard_e loc,
                               const ghostty_clipboard_content_s *content,
                               size_t len, bool confirm) {
  Session *s = ud;
  (void)confirm;
  if (!s) return;
  /* Take the first text/plain-ish entry (ghostty sends mime pairs). */
  for (size_t i = 0; i < len; i++) {
    if (content[i].data) {
      session_push_event(s, EV_CLIPBOARD_WRITE, content[i].data, 0,
                         (double)loc, NULL);
      return;
    }
  }
}

static void cb_close_surface(void *ud, bool alive) {
  (void)ud;
  (void)alive;
}

static void session_dispose(Session *s) {
  pthread_mutex_lock(&s->ev_mu);
  for (Event *ev = s->ev_head; ev;) {
    Event *next = ev->next;
    free(ev->str);
    free(ev);
    ev = next;
  }
  s->ev_head = s->ev_tail = NULL;
  pthread_mutex_unlock(&s->ev_mu);
  if (s->last_surface) {
    CFRelease(s->last_surface);
    s->last_surface = NULL;
  }
  if (s->surface) {
    ghostty_surface_free(s->surface);
    s->surface = NULL;
  }
  if (s->app) {
    /* Drain pending work (e.g. surface teardown) before freeing. */
    ghostty_app_tick(s->app);
    ghostty_app_free(s->app);
    s->app = NULL;
  }
  if (s->config) {
    ghostty_config_free(s->config);
    s->config = NULL;
  }
}

static void session_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  Session *s = data;
  session_dispose(s);
  free(s);
}

static Session *get_session(napi_env env, napi_value v) {
  void *data = NULL;
  if (napi_get_value_external(env, v, &data) != napi_ok || !data) {
    napi_throw_error(env, NULL, "invalid session handle");
    return NULL;
  }
  return data;
}

static uint32_t get_u32(napi_env env, napi_value obj, const char *name,
                        uint32_t fallback) {
  napi_value v;
  uint32_t out = fallback;
  if (napi_get_named_property(env, obj, name, &v) == napi_ok)
    napi_get_value_uint32(env, v, &out);
  return out;
}

static double get_f64(napi_env env, napi_value obj, const char *name,
                      double fallback) {
  napi_value v;
  double out = fallback;
  if (napi_get_named_property(env, obj, name, &v) == napi_ok)
    napi_get_value_double(env, v, &out);
  return out;
}

static bool get_str(napi_env env, napi_value obj, const char *name, char *buf,
                    size_t cap) {
  napi_value v;
  size_t n;
  if (napi_get_named_property(env, obj, name, &v) != napi_ok) return false;
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) return false;
  return napi_get_value_string_utf8(env, v, buf, cap, &n) == napi_ok;
}

/* ── exports ──────────────────────────────────────────────────────── */

/** init() — global ghostty init; call once before create(). */
static napi_value InitGhostty(napi_env env, napi_callback_info info) {
  (void)info;
  if (!g_inited) {
    static char arg0[] = "ghostty-electron";
    static char *argv[] = {arg0};
    if (ghostty_init(1, argv) != 0) {
      napi_throw_error(env, NULL, "ghostty_init failed");
      return NULL;
    }
    g_inited = true;
  }
  return NULL;
}

/**
 * create(opts) -> external session
 * opts: { widthPx, heightPx, scale, fontSize?, command? }
 * The grid (cols/rows) is derived by ghostty from pixel size and cell
 * metrics, exactly like a real window.
 */
static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (!g_inited) {
    napi_throw_error(env, NULL, "call init() first");
    return NULL;
  }

  uint32_t width_px = get_u32(env, argv[0], "widthPx", 960);
  uint32_t height_px = get_u32(env, argv[0], "heightPx", 480);
  double scale = get_f64(env, argv[0], "scale", 2.0);
  double font_size = get_f64(env, argv[0], "fontSize", 0);
  char command[4096] = {0};
  bool has_command = get_str(env, argv[0], "command", command,
                             sizeof(command));
  char cwd[4096] = {0};
  bool has_cwd = get_str(env, argv[0], "cwd", cwd, sizeof(cwd));

  Session *s = calloc(1, sizeof(Session));
  pthread_mutex_init(&s->ev_mu, NULL);

  ghostty_config_t config = ghostty_config_new();
  /* Self-contained by default (no user config files), but accept an
   * opts.config string of ghostty config-file syntax ("background =
   * #282c34\npalette = 0=#000000\nscrollback-limit = ...") written to
   * a temp file — the C API only exposes file loading. This is the
   * generic passthrough: any ghostty option works. */
  char config_text[16384] = {0};
  if (get_str(env, argv[0], "config", config_text, sizeof(config_text)) &&
      config_text[0]) {
    char tmpl[] = "/tmp/electron-ghostty-cfg-XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd >= 0) {
      write(fd, config_text, strlen(config_text));
      close(fd);
      ghostty_config_load_file(config, tmpl);
      unlink(tmpl);
    }
  }
  ghostty_config_finalize(config);

  ghostty_runtime_config_s runtime = {0};
  runtime.userdata = s;
  runtime.wakeup_cb = cb_wakeup;
  runtime.action_cb = cb_action;
  runtime.read_clipboard_cb = cb_read_clipboard;
  runtime.confirm_read_clipboard_cb = cb_confirm_read_clipboard;
  runtime.write_clipboard_cb = cb_write_clipboard;
  runtime.close_surface_cb = cb_close_surface;

  ghostty_app_t app = ghostty_app_new(&runtime, config);
  if (!app) {
    ghostty_config_free(config);
    free(s);
    napi_throw_error(env, NULL, "ghostty_app_new failed");
    return NULL;
  }

  ghostty_surface_config_s surface_config = ghostty_surface_config_new();
  surface_config.platform_tag = GHOSTTY_PLATFORM_HEADLESS;
  surface_config.platform.headless.reserved = NULL;
  surface_config.userdata = s;
  surface_config.scale_factor = scale;
  if (font_size > 0) surface_config.font_size = (float)font_size;
  if (has_command && command[0]) surface_config.command = command;
  if (has_cwd && cwd[0]) surface_config.working_directory = cwd;

  ghostty_surface_t surface = ghostty_surface_new(app, &surface_config);
  if (!surface) {
    ghostty_app_free(app);
    ghostty_config_free(config);
    free(s);
    napi_throw_error(env, NULL, "ghostty_surface_new failed");
    return NULL;
  }

  ghostty_surface_set_content_scale(surface, scale, scale);
  ghostty_surface_set_size(surface, width_px, height_px);
  ghostty_surface_set_focus(surface, true);

  s->app = app;
  s->config = config;
  s->surface = surface;

  napi_value external;
  NAPI_CALL(env,
            napi_create_external(env, s, session_finalize, NULL, &external));
  return external;
}

/** destroy(h) — synchronous teardown (kills the child via surface_free). */
static napi_value Destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;
  session_dispose(s);
  return NULL;
}

/**
 * pumpMainQueue() — drain pending main-dispatch-queue blocks.
 *
 * Ghostty's render thread presents frames via dispatch_async to the
 * main queue (IOSurfaceLayer.setSurface). Electron's main process
 * pumps the main run loop for us; a utilityProcess is plain Node with
 * no CFRunLoop, so without this the layer contents never update after
 * the first synchronous draw. Must be called from the process's main
 * thread (Node's JS thread is).
 */
static napi_value PumpMainQueue(napi_env env, napi_callback_info info) {
  (void)env;
  (void)info;
  while (CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true) ==
         kCFRunLoopRunHandledSource) {
  }
  return NULL;
}

/**
 * drainEvents(h) -> [{type, str?, num?, state?}] — events queued by
 * ghostty's callbacks (title/pwd/bell/open-url/mouse-shape/clipboard)
 * since the last drain. Call on the present tick. Clipboard-read
 * events carry an opaque `state` Buffer to pass to completeClipboard.
 */
static napi_value DrainEvents(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s) return NULL;

  pthread_mutex_lock(&s->ev_mu);
  Event *head = s->ev_head;
  s->ev_head = s->ev_tail = NULL;
  pthread_mutex_unlock(&s->ev_mu);

  static const char *type_names[] = {
      "title", "pwd", "bell", "open-url", "mouse-shape",
      "clipboard-write", "clipboard-read",
  };

  napi_value arr;
  NAPI_CALL(env, napi_create_array(env, &arr));
  uint32_t i = 0;
  for (Event *ev = head; ev;) {
    napi_value obj, v;
    napi_create_object(env, &obj);
    napi_create_string_utf8(env, type_names[ev->type], NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, obj, "type", v);
    if (ev->str) {
      napi_create_string_utf8(env, ev->str, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, obj, "str", v);
    }
    napi_create_double(env, ev->num, &v);
    napi_set_named_property(env, obj, "num", v);
    if (ev->ptr) {
      napi_create_buffer_copy(env, sizeof(void *), &ev->ptr, NULL, &v);
      napi_set_named_property(env, obj, "state", v);
    }
    napi_set_element(env, arr, i++, obj);
    Event *next = ev->next;
    free(ev->str);
    free(ev);
    ev = next;
  }
  return arr;
}

/**
 * completeClipboard(h, stateBuffer, text) — answer a clipboard-read
 * event: hand ghostty the clipboard text (it encodes/brackets the
 * paste itself and frees the request state).
 */
static napi_value CompleteClipboard(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  void *buf = NULL;
  size_t len = 0;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &buf, &len));
  if (len != sizeof(void *)) {
    napi_throw_error(env, NULL, "invalid clipboard state");
    return NULL;
  }
  void *state;
  memcpy(&state, buf, sizeof(void *));

  char text[65536];
  size_t n;
  NAPI_CALL(env,
            napi_get_value_string_utf8(env, argv[2], text, sizeof(text), &n));
  ghostty_surface_complete_clipboard_request(s->surface, text, state, false);
  return NULL;
}

/** setFocus(h, focused) — window focus/blur (DECSET 1004 etc). */
static napi_value SetFocus(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;
  bool focused = true;
  napi_get_value_bool(env, argv[1], &focused);
  ghostty_surface_set_focus(s->surface, focused);
  return NULL;
}

/** tick(h) — drain ghostty's app loop. Call on wakeup + periodically. */
static napi_value Tick(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->app) return NULL;
  g_wakeup = false;
  ghostty_app_tick(s->app);
  return NULL;
}

/** wakeupPending() -> bool — ghostty requested a tick. */
static napi_value WakeupPending(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out;
  NAPI_CALL(env, napi_get_boolean(env, g_wakeup, &out));
  return out;
}

/** draw(h) — force a synchronous render of current state. */
static napi_value Draw(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;
  ghostty_surface_draw(s->surface);
  return NULL;
}

/** frame(h) -> { handle, width, height, scale } | null */
static napi_value Frame(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  ghostty_headless_frame_s frame =
      ghostty_surface_headless_frame(s->surface);
  if (!frame.iosurface) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  if (s->last_surface) CFRelease(s->last_surface);
  s->last_surface = frame.iosurface; /* keep +1 until next frame() */

  napi_value result, v, handle;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_buffer_copy(env, sizeof(void *),
                                         &frame.iosurface, NULL, &handle));
  NAPI_CALL(env, napi_set_named_property(env, result, "handle", handle));
  NAPI_CALL(env, napi_create_uint32(env, frame.width_px, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, frame.height_px, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_create_double(env, frame.scale, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "scale", v));
  return result;
}

/** readPixels(h) -> { width, height, data } — BGRA copy, for tests. */
static napi_value ReadPixels(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  ghostty_headless_frame_s frame =
      ghostty_surface_headless_frame(s->surface);
  if (!frame.iosurface) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  IOSurfaceRef surf = (IOSurfaceRef)frame.iosurface;
  IOSurfaceLock(surf, kIOSurfaceLockReadOnly, NULL);
  const uint8_t *base = IOSurfaceGetBaseAddress(surf);
  size_t stride = IOSurfaceGetBytesPerRow(surf);
  size_t w = IOSurfaceGetWidth(surf), h = IOSurfaceGetHeight(surf);

  napi_value data;
  void *out;
  NAPI_CALL(env, napi_create_buffer(env, w * h * 4, &out, &data));
  for (size_t y = 0; y < h; y++)
    memcpy((uint8_t *)out + y * w * 4, base + y * stride, w * 4);
  IOSurfaceUnlock(surf, kIOSurfaceLockReadOnly, NULL);
  CFRelease(surf);

  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)w, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "width", v));
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)h, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "height", v));
  NAPI_CALL(env, napi_set_named_property(env, result, "data", data));
  return result;
}

/** size(h) -> grid + pixel + cell metrics (ghostty derives the grid). */
static napi_value GetSize(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  ghostty_surface_size_s sz = ghostty_surface_size(s->surface);
  napi_value result, v;
  NAPI_CALL(env, napi_create_object(env, &result));
#define SET(name, val)                                                     \
  NAPI_CALL(env, napi_create_uint32(env, (uint32_t)(val), &v));            \
  NAPI_CALL(env, napi_set_named_property(env, result, name, v));
  SET("cols", sz.columns)
  SET("rows", sz.rows)
  SET("widthPx", sz.width_px)
  SET("heightPx", sz.height_px)
  SET("cellWidth", sz.cell_width_px)
  SET("cellHeight", sz.cell_height_px)
#undef SET
  return result;
}

/** resize(h, widthPx, heightPx) — ghostty reflows + resizes PTY. */
static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  uint32_t w, h;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &w));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[2], &h));
  ghostty_surface_set_size(s->surface, w, h);
  return NULL;
}

/** text(h, string) — cooked text input (typing, paste). */
static napi_value Text(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  char buf[8192];
  size_t n;
  NAPI_CALL(env,
            napi_get_value_string_utf8(env, argv[1], buf, sizeof(buf), &n));
  ghostty_surface_text(s->surface, buf, n);
  return NULL;
}

/**
 * key(h, {action, key, mods, text?, unshiftedCodepoint?}) -> bool
 * action: 0=release 1=press 2=repeat; key: ghostty_input_key_e;
 * mods: ghostty_input_mods_e bitmask. Goes through ghostty's full
 * key encoder (kitty protocol, mode-aware arrows, etc.).
 */
static napi_value Key(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  char text[64] = {0};
  bool has_text = get_str(env, argv[1], "text", text, sizeof(text));

  ghostty_input_key_s key = {0};
  key.action = (ghostty_input_action_e)get_u32(env, argv[1], "action", 1);
  key.keycode = get_u32(env, argv[1], "keycode", 0);
  key.mods = (ghostty_input_mods_e)get_u32(env, argv[1], "mods", 0);
  key.consumed_mods =
      (ghostty_input_mods_e)get_u32(env, argv[1], "consumedMods", 0);
  key.text = has_text && text[0] ? text : NULL;
  key.unshifted_codepoint = get_u32(env, argv[1], "unshiftedCodepoint", 0);
  key.composing = false;

  napi_value out;
  NAPI_CALL(env, napi_get_boolean(env, ghostty_surface_key(s->surface, key),
                                  &out));
  return out;
}

/** mouseButton(h, action, button, mods) — 1=press 0=release. */
static napi_value MouseButton(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  uint32_t action, button, mods;
  NAPI_CALL(env, napi_get_value_uint32(env, argv[1], &action));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[2], &button));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[3], &mods));
  ghostty_surface_mouse_button(s->surface,
                               (ghostty_input_mouse_state_e)action,
                               (ghostty_input_mouse_button_e)button,
                               (ghostty_input_mods_e)mods);
  return NULL;
}

/** mousePos(h, x, y, mods) — surface-px position. */
static napi_value MousePos(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  double x, y;
  uint32_t mods;
  NAPI_CALL(env, napi_get_value_double(env, argv[1], &x));
  NAPI_CALL(env, napi_get_value_double(env, argv[2], &y));
  NAPI_CALL(env, napi_get_value_uint32(env, argv[3], &mods));
  ghostty_surface_mouse_pos(s->surface, x, y, (ghostty_input_mods_e)mods);
  return NULL;
}

/** mouseScroll(h, x, y, dx, dy) — ghostty routes scrollback/alt/reports. */
static napi_value MouseScroll(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  double x, y, dx, dy;
  NAPI_CALL(env, napi_get_value_double(env, argv[1], &x));
  NAPI_CALL(env, napi_get_value_double(env, argv[2], &y));
  NAPI_CALL(env, napi_get_value_double(env, argv[3], &dx));
  NAPI_CALL(env, napi_get_value_double(env, argv[4], &dy));
  ghostty_surface_mouse_pos(s->surface, x, y, 0);
  ghostty_input_scroll_mods_t mods = 0;
  ghostty_surface_mouse_scroll(s->surface, dx, dy, mods);
  return NULL;
}

/* ── cross-process IOSurface handoff via mach ports ─────────────────
 *
 * IOSurfaceRefs are process-local; frames produced by ghostty in a
 * utilityProcess must be re-derived in the presenting process.
 * IOSurfaceCreateMachPort / IOSurfaceLookupFromMachPort is Apple's
 * sanctioned way to pass a surface "atomically or securely ... to
 * another task" (IOSurfaceRef.h) — unlike the deprecated
 * kIOSurfaceIsGlobal, the port is an unguessable capability.
 *
 * Electron's parentPort can't carry mach send-rights, so the channel
 * is built here: the PARENT allocates a receive port and registers it
 * with the per-session bootstrap server under a unique name
 * (machChannelCreate); the HOST looks the name up (machSenderOpen)
 * and, per frame, moves one IOSurface port right + an inline seq via
 * mach_msg (machSendSurface). The host sends the mach message BEFORE
 * posting the 'frame' JS message, and the flow control is
 * one-frame-in-flight, so when the parent handles the JS message a
 * single mach message is already queued: machChannelReceiveSurface is
 * a bounded-timeout receive, no dedicated thread needed.
 *
 * A live port created from an IOSurface holds +1 on the surface's
 * global use count, so the frame can't be recycled mid-transfer even
 * across a resize; both sides deallocate their right promptly.
 */

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  uint64_t seq;
} FrameMsg;

typedef struct {
  FrameMsg msg;
  mach_msg_trailer_t trailer;
} FrameMsgRecv;

/** machChannelCreate(name) -> external — parent side; registers a
 * receive port with bootstrap under `name`. */
static void channel_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  mach_port_t port = (mach_port_t)(uintptr_t)data;
  if (port != MACH_PORT_NULL)
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
}

static napi_value MachChannelCreate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char name[128];
  size_t n;
  NAPI_CALL(env,
            napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &n));

  mach_port_t port = MACH_PORT_NULL;
  kern_return_t kr =
      mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port);
  if (kr != KERN_SUCCESS) {
    napi_throw_error(env, NULL, "mach_port_allocate failed");
    return NULL;
  }
  kr = mach_port_insert_right(mach_task_self(), port, port,
                              MACH_MSG_TYPE_MAKE_SEND);
  if (kr != KERN_SUCCESS) {
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
    napi_throw_error(env, NULL, "mach_port_insert_right failed");
    return NULL;
  }
  /* bootstrap_register is marked deprecated (launchd wants static
   * registrations) but remains the supported dynamic-name mechanism
   * for exactly this parent/child rendezvous shape. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  kr = bootstrap_register(bootstrap_port, name, port);
#pragma clang diagnostic pop
  /* The bootstrap server took its own right; drop the one we made. */
  mach_port_deallocate(mach_task_self(), port);
  if (kr != KERN_SUCCESS) {
    mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
    napi_throw_error(env, NULL, "bootstrap_register failed");
    return NULL;
  }

  napi_value external;
  NAPI_CALL(env, napi_create_external(env, (void *)(uintptr_t)port,
                                      channel_finalize, NULL, &external));
  return external;
}

/**
 * machChannelReceiveSurface(channel, timeoutMs)
 *   -> { handle: Buffer(IOSurfaceRef +1), seq } | null (timeout)
 * Caller must surfaceRelease() the handle when done presenting.
 */
static napi_value MachChannelReceiveSurface(napi_env env,
                                            napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  void *data = NULL;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], &data));
  mach_port_t port = (mach_port_t)(uintptr_t)data;
  uint32_t timeout_ms = 1000;
  napi_get_value_uint32(env, argv[1], &timeout_ms);

  FrameMsgRecv recv;
  memset(&recv, 0, sizeof(recv));
  recv.msg.header.msgh_size = sizeof(recv);
  recv.msg.header.msgh_local_port = port;
  kern_return_t kr =
      mach_msg(&recv.msg.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0,
               sizeof(recv), port, timeout_ms, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  mach_port_t surf_port = recv.msg.port.name;
  IOSurfaceRef surf = IOSurfaceLookupFromMachPort(surf_port); /* +1 */
  mach_port_deallocate(mach_task_self(), surf_port);
  if (!surf) {
    napi_value null_val;
    NAPI_CALL(env, napi_get_null(env, &null_val));
    return null_val;
  }

  napi_value result, handle, v;
  NAPI_CALL(env, napi_create_object(env, &result));
  NAPI_CALL(env,
            napi_create_buffer_copy(env, sizeof(void *), &surf, NULL, &handle));
  NAPI_CALL(env, napi_set_named_property(env, result, "handle", handle));
  NAPI_CALL(env, napi_create_double(env, (double)recv.msg.seq, &v));
  NAPI_CALL(env, napi_set_named_property(env, result, "seq", v));
  return result;
}

/** machSenderOpen(name, timeoutMs) -> external — host side; looks up
 * the parent's channel (retries until the parent has registered). */
static void sender_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  mach_port_t port = (mach_port_t)(uintptr_t)data;
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
}

static napi_value MachSenderOpen(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char name[128];
  size_t n;
  NAPI_CALL(env,
            napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &n));
  uint32_t timeout_ms = 5000;
  napi_get_value_uint32(env, argv[1], &timeout_ms);

  mach_port_t send_port = MACH_PORT_NULL;
  kern_return_t kr = KERN_FAILURE;
  /* The parent registers before forking us, so the first try should
   * hit; retry briefly to be robust against races. */
  for (uint32_t waited = 0;; waited += 50) {
    kr = bootstrap_look_up(bootstrap_port, name, &send_port);
    if (kr == KERN_SUCCESS || waited >= timeout_ms) break;
    usleep(50 * 1000);
  }
  if (kr != KERN_SUCCESS) {
    napi_throw_error(env, NULL, "bootstrap_look_up failed");
    return NULL;
  }

  napi_value external;
  NAPI_CALL(env, napi_create_external(env, (void *)(uintptr_t)send_port,
                                      sender_finalize, NULL, &external));
  return external;
}

/**
 * machSendSurface(sender, surfaceHandle, seq) -> bool
 * Wraps the IOSurface in a mach port and moves the right to the
 * parent. Returns false if the send failed (parent gone / queue full);
 * the caller should skip the frame, not crash.
 */
static napi_value MachSendSurface(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  void *data = NULL;
  NAPI_CALL(env, napi_get_value_external(env, argv[0], &data));
  mach_port_t send_port = (mach_port_t)(uintptr_t)data;

  void *buf = NULL;
  size_t len = 0;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[1], &buf, &len));
  if (len != sizeof(void *)) {
    napi_throw_error(env, NULL, "invalid surface handle");
    return NULL;
  }
  IOSurfaceRef surf;
  memcpy(&surf, buf, sizeof(void *));

  double seq_d = 0;
  NAPI_CALL(env, napi_get_value_double(env, argv[2], &seq_d));

  mach_port_t surf_port = IOSurfaceCreateMachPort(surf);
  napi_value out;
  if (surf_port == MACH_PORT_NULL) {
    NAPI_CALL(env, napi_get_boolean(env, false, &out));
    return out;
  }

  FrameMsg msg;
  memset(&msg, 0, sizeof(msg));
  msg.header.msgh_bits =
      MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
  msg.header.msgh_size = sizeof(msg);
  msg.header.msgh_remote_port = send_port;
  msg.body.msgh_descriptor_count = 1;
  msg.port.name = surf_port;
  msg.port.disposition = MACH_MSG_TYPE_MOVE_SEND;
  msg.port.type = MACH_MSG_PORT_DESCRIPTOR;
  msg.seq = (uint64_t)seq_d;

  kern_return_t kr = mach_msg(&msg.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
                              sizeof(msg), 0, MACH_PORT_NULL, 100 /* ms */,
                              MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    /* MOVE_SEND didn't happen; drop our right so the surface's global
     * use count doesn't leak. */
    mach_port_deallocate(mach_task_self(), surf_port);
    NAPI_CALL(env, napi_get_boolean(env, false, &out));
    return out;
  }
  NAPI_CALL(env, napi_get_boolean(env, true, &out));
  return out;
}

/** surfaceRelease(handle) — CFRelease a received surface handle. */
static napi_value SurfaceRelease(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  void *data = NULL;
  size_t len = 0;
  NAPI_CALL(env, napi_get_buffer_info(env, argv[0], &data, &len));
  if (len != sizeof(void *)) {
    napi_throw_error(env, NULL, "invalid surface handle");
    return NULL;
  }
  void *surf;
  memcpy(&surf, data, sizeof(void *));
  if (surf) CFRelease((IOSurfaceRef)surf);
  return NULL;
}

/** processExited(h) -> bool */
static napi_value ProcessExited(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Session *s = get_session(env, argv[0]);
  if (!s || !s->surface) return NULL;

  napi_value out;
  NAPI_CALL(env, napi_get_boolean(
                     env, ghostty_surface_process_exited(s->surface), &out));
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"init", NULL, InitGhostty, NULL, NULL, NULL, napi_default, NULL},
      {"pumpMainQueue", NULL, PumpMainQueue, NULL, NULL, NULL, napi_default,
       NULL},
      {"create", NULL, Create, NULL, NULL, NULL, napi_default, NULL},
      {"destroy", NULL, Destroy, NULL, NULL, NULL, napi_default, NULL},
      {"tick", NULL, Tick, NULL, NULL, NULL, napi_default, NULL},
      {"wakeupPending", NULL, WakeupPending, NULL, NULL, NULL, napi_default,
       NULL},
      {"draw", NULL, Draw, NULL, NULL, NULL, napi_default, NULL},
      {"drainEvents", NULL, DrainEvents, NULL, NULL, NULL, napi_default,
       NULL},
      {"completeClipboard", NULL, CompleteClipboard, NULL, NULL, NULL,
       napi_default, NULL},
      {"setFocus", NULL, SetFocus, NULL, NULL, NULL, napi_default, NULL},
      {"frame", NULL, Frame, NULL, NULL, NULL, napi_default, NULL},
      {"readPixels", NULL, ReadPixels, NULL, NULL, NULL, napi_default, NULL},
      {"size", NULL, GetSize, NULL, NULL, NULL, napi_default, NULL},
      {"resize", NULL, Resize, NULL, NULL, NULL, napi_default, NULL},
      {"text", NULL, Text, NULL, NULL, NULL, napi_default, NULL},
      {"key", NULL, Key, NULL, NULL, NULL, napi_default, NULL},
      {"mouseButton", NULL, MouseButton, NULL, NULL, NULL, napi_default,
       NULL},
      {"mousePos", NULL, MousePos, NULL, NULL, NULL, napi_default, NULL},
      {"mouseScroll", NULL, MouseScroll, NULL, NULL, NULL, napi_default,
       NULL},
      {"machChannelCreate", NULL, MachChannelCreate, NULL, NULL, NULL,
       napi_default, NULL},
      {"machChannelReceiveSurface", NULL, MachChannelReceiveSurface, NULL,
       NULL, NULL, napi_default, NULL},
      {"machSenderOpen", NULL, MachSenderOpen, NULL, NULL, NULL, napi_default,
       NULL},
      {"machSendSurface", NULL, MachSendSurface, NULL, NULL, NULL,
       napi_default, NULL},
      {"surfaceRelease", NULL, SurfaceRelease, NULL, NULL, NULL, napi_default,
       NULL},
      {"processExited", NULL, ProcessExited, NULL, NULL, NULL, napi_default,
       NULL},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]),
                         props);
  return exports;
}

NAPI_MODULE(ghostty_renderer, Init)
