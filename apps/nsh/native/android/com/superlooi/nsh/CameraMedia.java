package com.superlooi.nsh;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.opengl.*;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Proxy;
import java.nio.*;
import java.util.*;
import java.util.concurrent.*;

/** One decoder-owned OES texture serves both optional preview and on-demand JPEG. */
public final class CameraMedia {
    static native void registerVm();
    private static native void foregroundChanged(boolean active);
    private static final Map<String,WeakReference<CameraMedia>> sessions = new ConcurrentHashMap<>();
    static void foreground(boolean active) { foregroundChanged(active); }
    private final String id;
    private final HandlerThread thread = new HandlerThread("looi-camera-media");
    private final Handler handler;
    private volatile boolean closed;
    private volatile long frames, pts, receivedAt;
    private volatile int width, height, error;
    private volatile boolean displayed;
    private MediaCodec codec;
    private long revision=-1;
    private EGLDisplay display;
    private EGLContext egl;
    private EGLConfig config;
    private EGLSurface pbuffer, window;
    private Surface output, previewSurface;
    private SurfaceTexture texture, previewTexture;
    private int oes, program;
    private int previewWidth, previewHeight;
    private final float[] matrix=new float[16];
    private final Map<Long,Long> arrivals=new HashMap<>();
    private final FloatBuffer quad=ByteBuffer.allocateDirect(16*4).order(ByteOrder.nativeOrder()).asFloatBuffer();

    public static CameraMedia create(String id) { return new CameraMedia(id); }
    private CameraMedia(String id) {
        this.id=id;
        quad.put(new float[]{-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1}).position(0);
        thread.start(); handler=new Handler(thread.getLooper()); sessions.put(id,new WeakReference<>(this));
        call(() -> { initGl(); return null; });
    }
    private <T> T call(Callable<T> work) {
        FutureTask<T> task=new FutureTask<>(work); handler.post(task);
        try { return task.get(5,TimeUnit.SECONDS); }
        catch (Exception failure) { error=-1; throw new IllegalStateException("camera_media_failed",failure); }
    }
    private static int shader(int kind,String source) {
        int shader=GLES20.glCreateShader(kind); GLES20.glShaderSource(shader,source); GLES20.glCompileShader(shader);
        int[] ok=new int[1]; GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,ok,0);
        if(ok[0]==0) throw new IllegalStateException("camera_shader_compile"); return shader;
    }
    private void initGl() {
        display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] version=new int[2]; if(!EGL14.eglInitialize(display,version,0,version,1)) throw new IllegalStateException("camera_egl_init");
        EGLConfig[] configs=new EGLConfig[1]; int[] count=new int[1];
        int[] attrs={EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_PBUFFER_BIT|EGL14.EGL_WINDOW_BIT,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_NONE};
        if(!EGL14.eglChooseConfig(display,attrs,0,configs,0,1,count,0)||count[0]==0) throw new IllegalStateException("camera_egl_config");
        config=configs[0]; egl=EGL14.eglCreateContext(display,config,EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);
        pbuffer=EGL14.eglCreatePbufferSurface(display,config,new int[]{EGL14.EGL_WIDTH,1,EGL14.EGL_HEIGHT,1,EGL14.EGL_NONE},0);
        current(pbuffer);
        int[] textures=new int[1]; GLES20.glGenTextures(1,textures,0); oes=textures[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,oes);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_S,GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,GLES20.GL_TEXTURE_WRAP_T,GLES20.GL_CLAMP_TO_EDGE);
        texture=new SurfaceTexture(oes); output=new Surface(texture);
        texture.setOnFrameAvailableListener(value -> frame(),handler);
        int vertex=shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 p;attribute vec2 uv;uniform mat4 m;varying vec2 t;void main(){gl_Position=vec4(p,0.,1.);t=(m*vec4(uv,0.,1.)).xy;}");
        int fragment=shader(GLES20.GL_FRAGMENT_SHADER,"#extension GL_OES_EGL_image_external : require\nprecision mediump float;varying vec2 t;uniform samplerExternalOES s;void main(){gl_FragColor=texture2D(s,t);}");
        program=GLES20.glCreateProgram(); GLES20.glAttachShader(program,vertex); GLES20.glAttachShader(program,fragment); GLES20.glLinkProgram(program);
        GLES20.glDeleteShader(vertex); GLES20.glDeleteShader(fragment);
        int[] ok=new int[1]; GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,ok,0); if(ok[0]==0) throw new IllegalStateException("camera_shader_link");
    }
    private void current(EGLSurface surface) { if(!EGL14.eglMakeCurrent(display,surface,surface,egl)) throw new IllegalStateException("camera_egl_current"); }
    private void draw(int outWidth,int outHeight,boolean fit) {
        GLES20.glViewport(0,0,outWidth,outHeight); GLES20.glClearColor(0,0,0,1); GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        if(fit && width>0 && height>0) {
            float scale=Math.min((float)outWidth/width,(float)outHeight/height);
            int w=Math.round(width*scale),h=Math.round(height*scale); GLES20.glViewport((outWidth-w)/2,(outHeight-h)/2,w,h);
        }
        GLES20.glUseProgram(program); GLES20.glActiveTexture(GLES20.GL_TEXTURE0); GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,oes);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"s"),0); GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program,"m"),1,false,matrix,0);
        int p=GLES20.glGetAttribLocation(program,"p"),uv=GLES20.glGetAttribLocation(program,"uv");
        quad.position(0); GLES20.glEnableVertexAttribArray(p); GLES20.glVertexAttribPointer(p,2,GLES20.GL_FLOAT,false,16,quad);
        quad.position(2); GLES20.glEnableVertexAttribArray(uv); GLES20.glVertexAttribPointer(uv,2,GLES20.GL_FLOAT,false,16,quad);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4); GLES20.glDisableVertexAttribArray(p); GLES20.glDisableVertexAttribArray(uv);
    }
    public void feed(byte[] bytes,int kind,int w,int h,byte[] csd,long revision,long timestamp) {
        if(closed) return;
        call(() -> {
            if(closed) return null;
            if(codec==null || this.revision!=revision) {
                if(codec!=null) { codec.stop(); codec.release(); codec=null; }
                arrivals.clear(); width=w; height=h;
                String mime=kind==5 ? MediaFormat.MIMETYPE_VIDEO_HEVC : MediaFormat.MIMETYPE_VIDEO_AVC;
                MediaFormat format=MediaFormat.createVideoFormat(mime,w,h); format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE,2*1024*1024);
                format.setByteBuffer("csd-0",ByteBuffer.wrap(csd));
                codec=MediaCodec.createDecoderByType(mime); codec.configure(format,output,null,0); codec.start(); this.revision=revision;
            }
            drain(); int index=codec.dequeueInputBuffer(20000);
            for(int n=0;index<0 && n<10;n++) { drain(); index=codec.dequeueInputBuffer(20000); }
            if(index<0) throw new IllegalStateException("camera_decoder_busy");
            ByteBuffer buffer=codec.getInputBuffer(index); buffer.clear(); buffer.put(bytes);
            arrivals.put(timestamp,System.currentTimeMillis()); codec.queueInputBuffer(index,0,bytes.length,timestamp*1000,0); drain(); return null;
        });
    }
    private void drain() {
        MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();
        for(;;) {
            int index=codec.dequeueOutputBuffer(info,0);
            if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat format=codec.getOutputFormat();
                width=format.getInteger(MediaFormat.KEY_WIDTH); height=format.getInteger(MediaFormat.KEY_HEIGHT);
                if(format.containsKey("crop-right")) width=format.getInteger("crop-right")-format.getInteger("crop-left")+1;
                if(format.containsKey("crop-bottom")) height=format.getInteger("crop-bottom")-format.getInteger("crop-top")+1;
            } else if(index>=0) codec.releaseOutputBuffer(index,true); else break;
        }
    }
    private void frame() {
        if(closed) return;
        try {
            current(pbuffer); texture.updateTexImage(); texture.getTransformMatrix(matrix);
            pts=texture.getTimestamp()/1000000; Long arrival=arrivals.remove(pts); receivedAt=arrival==null ? System.currentTimeMillis() : arrival;
            // SurfaceTexture coalesces obsolete outputs; old arrival records are no longer needed.
            arrivals.entrySet().removeIf(entry -> entry.getKey()<pts); frames++;
            if(window!=null) { current(window); draw(previewWidth,previewHeight,true); displayed=EGL14.eglSwapBuffers(display,window); current(pbuffer); }
        } catch(RuntimeException failure) { error=-1; }
    }
    public long[] status() { return new long[]{frames,width,height,pts,error,displayed?1:0}; }
    public static final class Snapshot {
        public final byte[] data; public final int width,height; public final long receivedAt;
        Snapshot(byte[] data,int width,int height,long receivedAt) { this.data=data;this.width=width;this.height=height;this.receivedAt=receivedAt; }
    }
    public Snapshot jpeg() {
        if(closed) return null;
        return call(() -> {
            if(closed || frames==0) return null;
            current(pbuffer); float scale=Math.min(1f,1024f/Math.max(width,height)); int w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
            int[] target=new int[1],fbo=new int[1]; GLES20.glGenTextures(1,target,0); GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,target[0]);
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D,0,GLES20.GL_RGBA,w,h,0,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,null);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MIN_FILTER,GLES20.GL_LINEAR); GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D,GLES20.GL_TEXTURE_MAG_FILTER,GLES20.GL_LINEAR);
            GLES20.glGenFramebuffers(1,fbo,0); GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER,fbo[0]); GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER,GLES20.GL_COLOR_ATTACHMENT0,GLES20.GL_TEXTURE_2D,target[0],0);
            try {
                draw(w,h,false); ByteBuffer pixels=ByteBuffer.allocateDirect(w*h*4).order(ByteOrder.nativeOrder()); GLES20.glReadPixels(0,0,w,h,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,pixels);
                int[] argb=new int[w*h]; for(int y=0;y<h;y++) for(int x=0;x<w;x++) { int i=(y*w+x)*4; int r=pixels.get(i)&255,g=pixels.get(i+1)&255,b=pixels.get(i+2)&255;argb[(h-1-y)*w+x]=0xff000000|(r<<16)|(g<<8)|b; }
                Bitmap bitmap=Bitmap.createBitmap(argb,w,h,Bitmap.Config.ARGB_8888); ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                try { bitmap.compress(Bitmap.CompressFormat.JPEG,80,bytes); } finally { bitmap.recycle(); }
                return new Snapshot(bytes.toByteArray(),w,h,receivedAt);
            } finally { GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER,0); GLES20.glDeleteFramebuffers(1,fbo,0); GLES20.glDeleteTextures(1,target,0); }
        });
    }
    private void detachWindow() {
        if(window!=null) { current(pbuffer); EGL14.eglDestroySurface(display,window); window=null; }
        if(previewSurface!=null) { previewSurface.release(); previewSurface=null; }
        previewTexture=null; displayed=false;
    }
    private void bindWindow(SurfaceTexture value,int w,int h) {
        handler.post(() -> {
            if(closed) return;
            if(value!=previewTexture) { detachWindow(); previewTexture=value; previewSurface=new Surface(value); window=EGL14.eglCreateWindowSurface(display,config,previewSurface,new int[]{EGL14.EGL_NONE},0); }
            previewWidth=w; previewHeight=h;
        });
    }
    public void close() {
        if(closed) return; closed=true; sessions.remove(id);
        handler.post(() -> {
            try {
                if(codec!=null) { codec.stop(); codec.release(); codec=null; }
                detachWindow(); output.release(); texture.release(); current(pbuffer);
                GLES20.glDeleteTextures(1,new int[]{oes},0); GLES20.glDeleteProgram(program);
                EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);
                EGL14.eglDestroySurface(display,pbuffer); EGL14.eglDestroyContext(display,egl); EGL14.eglReleaseThread(); EGL14.eglTerminate(display);
            } finally { thread.quitSafely(); }
        });
    }
    // The plugin compiles against android.jar; NSH interfaces are supplied by its host.
    static void registerComponents(Activity activity) {
        View content=activity.findViewById(android.R.id.content);
        if(!(content instanceof FrameLayout) || ((FrameLayout)content).getChildCount()==0) return;
        View host=((FrameLayout)content).getChildAt(0);
        if(!host.getClass().getName().equals("com.longbridge.nsh.NshView")) return;
        try {
            ClassLoader loader=host.getClass().getClassLoader(); Class<?> factory=Class.forName("com.longbridge.nsh.NshComponent$Factory",true,loader);
            Class<?> component=Class.forName("com.longbridge.nsh.NshComponent",true,loader);
            Object value=Proxy.newProxyInstance(loader,new Class<?>[]{factory},(proxy,method,args) -> {
                if(method.getName().equals("create")) {
                    Preview preview=new Preview(activity,args[0]);
                    return Proxy.newProxyInstance(loader,new Class<?>[]{component},(p,m,a) -> {
                        switch(m.getName()) {
                            case "view":return preview;
                            case "setProp":if("sessionId".equals(a[0])) preview.bind(a[1] instanceof String ? (String)a[1] : "");return null;
                            case "destroy":preview.destroy();return null;
                            case "toString":return "CameraVideo";
                            case "hashCode":return System.identityHashCode(p);
                            case "equals":return p==a[0];
                            default:return null;
                        }
                    });
                }
                if(method.getName().equals("hashCode")) return System.identityHashCode(proxy);
                if(method.getName().equals("equals")) return proxy==args[0];
                return "CameraVideoFactory";
            });
            host.getClass().getMethod("registerComponent",String.class,factory).invoke(host,"looi.CameraVideo",value);
        } catch(ReflectiveOperationException failure) { throw new IllegalStateException("camera_component_register",failure); }
    }
    private static final class Preview extends TextureView implements TextureView.SurfaceTextureListener {
        private CameraMedia media; private final Object context; private final Handler main=new Handler(android.os.Looper.getMainLooper());
        private final Runnable observer=new Runnable() { public void run() {
            if(media==null) return;
            Map<String,Object> state=new HashMap<>(); long[] s=media.status(); state.put("sessionId",media.id);state.put("frames",s[0]);state.put("width",s[1]);state.put("height",s[2]);state.put("timestampMs",s[3]);state.put("error",s[4]);state.put("displayed",s[5]!=0);state.put("closed",media.closed);state.put("failure",s[4]==0?null:"camera_decode_failed");
            try { context.getClass().getMethod("emit",String.class,Object.class).invoke(context,"state",state); }
            catch(ReflectiveOperationException failure) { throw new IllegalStateException("camera_component_event",failure); }
            main.postDelayed(this,250);
        }};
        Preview(Context owner,Object context) { super(owner);this.context=context;setSurfaceTextureListener(this); }
        void bind(String id) {
            destroy(); WeakReference<CameraMedia> ref=sessions.get(id); media=ref==null?null:ref.get();
            if(media!=null) { if(isAvailable()) media.bindWindow(getSurfaceTexture(),getWidth(),getHeight());main.post(observer); }
        }
        void destroy() { main.removeCallbacks(observer); if(media!=null) { CameraMedia old=media;old.handler.post(old::detachWindow);media=null; } }
        public void onSurfaceTextureAvailable(SurfaceTexture value,int w,int h) { if(media!=null) media.bindWindow(value,w,h); }
        public void onSurfaceTextureSizeChanged(SurfaceTexture value,int w,int h) { if(media!=null) media.bindWindow(value,w,h); }
        public boolean onSurfaceTextureDestroyed(SurfaceTexture value) {
            if(media!=null) { CameraMedia old=media;old.handler.post(() -> {old.detachWindow();value.release();});return false; } return true;
        }
        public void onSurfaceTextureUpdated(SurfaceTexture value) {}
    }
}
