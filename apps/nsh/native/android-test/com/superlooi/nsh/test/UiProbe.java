package com.superlooi.nsh.test;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;

/** Separate test APK: acts through Android's system accessibility/input APIs.
 * NSH's fixed Android test driver types into the base window, missing Dialogs.
 * No app method or state is injected; this APK never ships with Super LOOI. */
public final class UiProbe extends Instrumentation {
    private UiAutomation automation;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            automation = getUiAutomation();
            waitText("本机就绪", 20000);
            tapText("连接"); waitText("连接设置", 5000);
            tapText("关闭"); waitText("对话", 5000);
            String marker = "NSH原生验收" + System.currentTimeMillis();
            message("记住" + marker + "在书架上");
            waitText("记住了：" + marker + "在书架上", 10000);
            message("回忆 " + marker); waitText(marker + "在书架上", 10000);
            message("忘记 " + marker); waitText("已忘记这条内容。", 10000);
            result.putString("result", "PASS native Android face/settings and offline remember/recall/forget through system input");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL " + error.getClass().getSimpleName() + ": " + error.getMessage());
            finish(0, result);
        }
    }
    private List<AccessibilityNodeInfo> nodes() {
        List<AccessibilityNodeInfo> all = new ArrayList<>();
        collect(automation.getRootInActiveWindow(), all); return all;
    }
    private void collect(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> all) {
        if (node == null) return; all.add(node);
        for (int i=0;i<node.getChildCount();i++)collect(node.getChild(i),all);
    }
    private AccessibilityNodeInfo text(String value) {
        for(AccessibilityNodeInfo node:nodes())if(node.isVisibleToUser() && value.contentEquals(node.getText()==null?"":node.getText()))return node;
        return null;
    }
    private void waitText(String value, long timeout) {
        long end=SystemClock.uptimeMillis()+timeout;
        while(SystemClock.uptimeMillis()<end){if(text(value)!=null)return;SystemClock.sleep(80);}
        throw new IllegalStateException("Expected UI text was not visible: "+value);
    }
    private void tapText(String value) {
        AccessibilityNodeInfo node=text(value);
        if(node==null)throw new IllegalStateException("No visible target: "+value);
        tap(node);
    }
    private void tap(AccessibilityNodeInfo node) {
        Rect bounds=new Rect();node.getBoundsInScreen(bounds);
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,bounds.exactCenterX(),bounds.exactCenterY(),0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);automation.injectInputEvent(down,true);down.recycle();
        SystemClock.sleep(65);
        MotionEvent up=MotionEvent.obtain(now,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,bounds.exactCenterX(),bounds.exactCenterY(),0);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);automation.injectInputEvent(up,true);up.recycle();
        SystemClock.sleep(250);
    }
    private void message(String value) {
        tapText("对话");
        long end=SystemClock.uptimeMillis()+5000;
        AccessibilityNodeInfo input=null;
        while(input==null && SystemClock.uptimeMillis()<end){
            for(AccessibilityNodeInfo node:nodes())if(node.isVisibleToUser()&&node.isEditable()){input=node;break;}
            if(input==null)SystemClock.sleep(80);
        }
        if(input==null)throw new IllegalStateException("No editable message field");
        tap(input);
        Bundle args=new Bundle();args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value);
        if(!input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args))throw new IllegalStateException("System text input was refused");
        SystemClock.sleep(300);
        long now=SystemClock.uptimeMillis();
        automation.injectInputEvent(new KeyEvent(now,now,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_ENTER,0),true);
        automation.injectInputEvent(new KeyEvent(now,SystemClock.uptimeMillis(),KeyEvent.ACTION_UP,KeyEvent.KEYCODE_ENTER,0),true);
        SystemClock.sleep(250);
    }
}
