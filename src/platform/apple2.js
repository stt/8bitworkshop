"use strict";

var APPLE2_PRESETS = [
];

var GR_TXMODE   = 1;
var GR_MIXMODE  = 2;
var GR_PAGE1    = 4;
var GR_HIRES    = 8;

var Apple2Platform = function(mainElement) {
  var self = this;
  var cpuFrequency = 1023000;
  var cpuCyclesPerLine = 65;
  var cpu, ram, bus;
  var video, ap2disp, audio, timer;
  var grdirty = new Array(0xc000 >> 7);
  var grswitch = GR_TXMODE;
  var kbdlatch = 0;
  var soundstate = 0;
  var PGM_BASE = 0x6000; // where to JMP after pr#6
  // language card switches
  var auxRAMselected = false;
  var auxRAMbank = 1;
  var writeinhibit = true;
  // value to add when reading & writing each of these banks
  // bank 1 is E000-FFFF, bank 2 is D000-DFFF
  var bank2rdoffset=0, bank2wroffset=0;

  this.getPresets = function() {
    return APPLE2_PRESETS;
  }

  function noise() {
    return (Math.random() * 256) & 0xff;
  }

  this.start = function() {
    cpu = new jt.M6502();
    ram = new RAM(0x13000); // 64K + 16K LC RAM - 4K hardware
    // ROM
    var rom = new lzgmini().decode(APPLEIIGO_LZG).slice(0,0x3000);
    //var rom = new lzgmini().decode(APPLEII_ROM).slice(0,0x3000);
    ram.mem.set(rom, 0xd000);
    // bus
    bus = {
      read: function(address) {
        address &= 0xffff;
        if (address < 0xc000) {
          return ram.mem[address];
        } else if (address >= 0xd000) {
          //return rom[address - 0xd000] & 0xff;
          //console.log(hex(address), rom[address-0xd000], ram.mem[address]);
          if (!auxRAMselected)
            return rom[address - 0xd000];
          else if (address >= 0xe000)
            return ram.mem[address];
          else
            return ram.mem[address + bank2rdoffset];
        } else if (address < 0xc100) {
          var slot = (address >> 4) & 0x0f;
          switch (slot)
          {
             case 0:
                return kbdlatch;
             case 1:
                kbdlatch &= 0x7f;
                break;
             case 3:
                soundstate = soundstate ^ 1;
                break;
             case 5:
                if ((address & 0x0f) < 8) {
                   // graphics
                   if ((address & 1) != 0)
                      grswitch |= 1 << ((address >> 1) & 0x07);
                   else
                      grswitch &= ~(1 << ((address >> 1) & 0x07));
                }
                break;
             case 6:
                // tapein, joystick, buttons
                switch (address & 7) {
                   // buttons (off)
                   case 1:
                   case 2:
                   case 3:
                      return noise() & 0x7f;
                    // joystick
                   case 4:
                   case 5:
                      return noise() | 0x80;
                   default:
                      return noise();
                }
             case 7:
                // joy reset
                if (address == 0xc070)
                   return noise() | 0x80;
             case 8:
                return 0; // TODO doLanguageCardIO(address, value);
             case 9: case 10: case 11: case 12: case 13: case 14: case 15:
                return noise(); // return slots[slot-8].doIO(address, value);
          }
        } else {
          switch (address) {
            // JMP $c600
            case 0xc600: return 0x4c;
            case 0xc601: return PGM_BASE&0xff;
            case 0xc602: return (PGM_BASE>>8)&0xff;
            default: return noise();
          }
        }
        return noise();
      },
      write: function(address, val) {
        address &= 0xffff;
        val &= 0xff;
        if (address < 0xc000) {
          ram.mem[address] = val;
          grdirty[address>>7] = 1;
        } else if (address < 0xc100) {
          this.read(address); // strobe address, discard result
        } else if (address >= 0xd000 && !writeinhibit) {
          if (address >= 0xe000)
            ram.mem[address] = val;
          else
            ram.mem[address + bank2wroffset] = val;
        }
      }
    };
    cpu.connectBus(bus);
    // create video/audio
    video = new RasterVideo(mainElement,280,192);
    audio = new SampleAudio(cpuFrequency);
    video.start();
    audio.start();
    video.setKeyboardEvents(function(key,code,flags) {
      // since we're an Apple II+, we don't do lowercase
      if (flags & 1) {
        if (code) {
          if (code >= 0xe1 && code <= 0xfa)
             code -= 0x20;
          kbdlatch = (code | 0x80) & 0xff;
        } else if (key) {
          kbdlatch = (key | 0x80) & 0xff;
        }
      }
    });
    var idata = video.getFrameData();
    var grparams = {dirty:grdirty, grswitch:grswitch, mem:ram.mem};
    ap2disp = new Apple2Display(idata, grparams);
    var colors = [0xffff0000, 0xff00ff00];
    timer = new AnimationTimer(60, function() {
      // 262.5 scanlines per frame
      var iaddr = 0x2000;
      var iofs = 0;
      breakClock = -1;
      var clock = 0;
      for (var sl=0; sl<262; sl++) {
        for (var i=0; i<cpuCyclesPerLine; i++) {
          if (debugCondition && breakClock < 0 && debugCondition()) { breakClock = clock; }
          clock++;
          cpu.clockPulse();
          audio.feedSample(soundstate, 1);
        }
      }
      grparams.dirty = grdirty;
      grparams.grswitch = grswitch;
      ap2disp.updateScreen();
      video.updateFrame();
      // TODO: reset debug state
    });
  }

  function doLanguageCardIO(address, value)
  {
     switch (address & 0x0f) {
         // Select aux RAM bank 2, write protected.
        case 0x0:
        case 0x4:
           auxRAMselected = true;
           auxRAMbank = 2;
           writeinhibit = true;
           break;
        // Select ROM, write enable aux RAM bank 2.
        case 0x1:
        case 0x5:
           auxRAMselected = false;
           auxRAMbank = 2;
           writeinhibit = false;
           break;
        // Select ROM, write protect aux RAM (either bank).
        case 0x2:
        case 0x6:
        case 0xA:
        case 0xE:
           auxRAMselected = false;
           writeinhibit = true;
           break;
        // Select aux RAM bank 2, write enabled.
        case 0x3:
        case 0x7:
           auxRAMselected = true;
           auxRAMbank = 2;
           writeinhibit = false;
           break;
        // Select aux RAM bank 1, write protected.
        case 0x8:
        case 0xC:
           auxRAMselected = true;
           auxRAMbank = 1;
           writeinhibit = true;
           break;
        // Select ROM, write enable aux RAM bank 1.
        case 0x9:
        case 0xD:
           auxRAMselected = false;
           auxRAMbank = 1;
           writeinhibit = false;
           break;
       // Select aux RAM bank 1, write enabled.
        case 0xB:
        case 0xF:
           auxRAMselected = true;
           auxRAMbank = 1;
           writeinhibit = false;
           break;
     }
     setupLanguageCardConstants();
     return noise();
  }

  function setupLanguageCardConstants() {
    // reset language card constants
     if (auxRAMbank == 2)
        bank2rdoffset = -0x1000;   // map 0xd000-0xdfff -> 0xc000-0xcfff
     else
        bank2rdoffset = 0x3000; // map 0xd000-0xdfff -> 0x10000-0x10fff
     if (auxRAMbank == 2)
        bank2wroffset = -0x1000;   // map 0xd000-0xdfff -> 0xc000-0xcfff
     else
        bank2wroffset = 0x3000; // map 0xd000-0xdfff -> 0x10000-0x10fff
  }

  this.getOpcodeMetadata = function(opcode, offset) {
    return Javatari.getOpcodeMetadata(opcode, offset); // TODO
  }

  this.loadROM = function(title, data) {
    this.reset();
    //console.log('loadROM',hex(data.length));
    ram.mem.set(data, PGM_BASE);
    /*
    if(data.length != 0x3000) {
      throw "ROM length must be == 0x3000";
    }
    rom = data;
    */
  }

  this.getRasterPosition = function() {
    return {x:0, y:0};
  }

  this.isRunning = function() {
    return timer.isRunning();
  }
  this.pause = function() {
    timer.stop();
    audio.stop();
  }
  this.resume = function() {
    timer.start();
    audio.start();
  }
  this.reset = function() {
    cpu.reset();
  }
  this.getOriginPC = function() {
    return (this.readAddress(0xfffc) | (this.readAddress(0xfffd) << 8)) & 0xffff;
  }
  this.readAddress = function(addr) {
    return bus.read(addr);
  }

  var onBreakpointHit;
  var debugCondition;
  var debugSavedState = null;
  var debugBreakState = null;
  var debugTargetClock = 0;
  var debugClock = 0;
  var debugFrameStartClock = 0;
  var breakClock;

  this.setDebugCondition = function(debugCond) {
    if (debugSavedState) {
      self.loadState(debugSavedState);
    } else {
      debugSavedState = self.saveState();
    }
    debugClock = 0;
    debugCondition = debugCond;
    self.resume();
  }
  this.setupDebug = function(callback) {
    onBreakpointHit = callback;
  }
  this.clearDebug = function() {
    debugSavedState = null;
    debugTargetClock = 0;
    debugClock = 0;
    debugFrameStartClock = 0;
    onBreakpointHit = null;
    debugCondition = null;
  }
  this.breakpointHit = function() {
    debugBreakState = self.saveState();
    debugBreakState.c.PC = (debugBreakState.c.PC-1) & 0xffff;
    console.log("Breakpoint at clk", debugClock, "PC", debugBreakState.c.PC.toString(16));
    this.pause();
    if (onBreakpointHit) {
      onBreakpointHit(debugBreakState);
    }
  }
  this.step = function() {
    var previousPC = -1;
    self.setDebugCondition(function() {
      if (debugClock++ > debugTargetClock) {
        var thisState = cpu.saveState();
        if (previousPC < 0) {
          previousPC = thisState.PC;
        } else {
          if (thisState.PC != previousPC && thisState.T == 0) {
            //console.log(previousPC.toString(16), thisPC.toString(16));
            debugTargetClock = debugClock-1;
            self.breakpointHit();
            return true;
          }
        }
      }
      return false;
    });
  }
  this.runEval = function(evalfunc) {
    var self = this;
    self.setDebugCondition(function() {
      if (debugClock++ > debugTargetClock) {
        var cpuState = cpu.saveState();
        cpuState.PC = (cpuState.PC-1)&0xffff;
        if (evalfunc(cpuState)) {
          self.breakpointHit();
          debugTargetClock = debugClock;
          return true;
        } else {
          return false;
        }
      }
    });
  }

  this.loadState = function(state) {
    cpu.loadState(state.c);
    ram.mem.set(state.b);
    kbdlatch = state.kbd;
    grswitch = state.gr;
    auxRAMselected = state.lc.s;
    auxRAMbank = state.lc.b;
    writeinhibit = state.lc.w;
    setupLanguageCardConstants();
  }
  this.saveState = function() {
    return {
      c:cpu.saveState(),
      b:ram.mem.slice(0),
      kbd:kbdlatch,
      gr:grswitch,
      lc:{s:auxRAMselected,b:auxRAMbank,w:writeinhibit},
    };
  }
  this.getRAMForState = function(state) {
    return ram.mem;
  }
};

var Apple2Display = function(pixels, apple) {
  var XSIZE = 280;
  var YSIZE = 192;
  var PIXELON = 0xffffffff;
  var PIXELOFF = 0xff000000;

  var oldgrmode = -1;
  var textbuf = new Array(40*24);

  var flashInterval = 500;

  var loresColor = [
     (0xff000000), (0xffff00ff), (0xff00007f), (0xff7f007f),
     (0xff007f00), (0xff7f7f7f), (0xff0000bf), (0xff0000ff),
     (0xffbf7f00), (0xffffbf00), (0xffbfbfbf), (0xffff7f7f),
     (0xff00ff00), (0xffffff00), (0xff00bf7f), (0xffffffff),
  ];

  var text_lut = [
     0x000, 0x080, 0x100, 0x180, 0x200, 0x280, 0x300, 0x380,
     0x028, 0x0a8, 0x128, 0x1a8, 0x228, 0x2a8, 0x328, 0x3a8,
     0x050, 0x0d0, 0x150, 0x1d0, 0x250, 0x2d0, 0x350, 0x3d0
  ];

  var hires_lut = [
     0x0000, 0x0400, 0x0800, 0x0c00, 0x1000, 0x1400, 0x1800, 0x1c00,
     0x0080, 0x0480, 0x0880, 0x0c80, 0x1080, 0x1480, 0x1880, 0x1c80,
     0x0100, 0x0500, 0x0900, 0x0d00, 0x1100, 0x1500, 0x1900, 0x1d00,
     0x0180, 0x0580, 0x0980, 0x0d80, 0x1180, 0x1580, 0x1980, 0x1d80,
     0x0200, 0x0600, 0x0a00, 0x0e00, 0x1200, 0x1600, 0x1a00, 0x1e00,
     0x0280, 0x0680, 0x0a80, 0x0e80, 0x1280, 0x1680, 0x1a80, 0x1e80,
     0x0300, 0x0700, 0x0b00, 0x0f00, 0x1300, 0x1700, 0x1b00, 0x1f00,
     0x0380, 0x0780, 0x0b80, 0x0f80, 0x1380, 0x1780, 0x1b80, 0x1f80,
     0x0028, 0x0428, 0x0828, 0x0c28, 0x1028, 0x1428, 0x1828, 0x1c28,
     0x00a8, 0x04a8, 0x08a8, 0x0ca8, 0x10a8, 0x14a8, 0x18a8, 0x1ca8,
     0x0128, 0x0528, 0x0928, 0x0d28, 0x1128, 0x1528, 0x1928, 0x1d28,
     0x01a8, 0x05a8, 0x09a8, 0x0da8, 0x11a8, 0x15a8, 0x19a8, 0x1da8,
     0x0228, 0x0628, 0x0a28, 0x0e28, 0x1228, 0x1628, 0x1a28, 0x1e28,
     0x02a8, 0x06a8, 0x0aa8, 0x0ea8, 0x12a8, 0x16a8, 0x1aa8, 0x1ea8,
     0x0328, 0x0728, 0x0b28, 0x0f28, 0x1328, 0x1728, 0x1b28, 0x1f28,
     0x03a8, 0x07a8, 0x0ba8, 0x0fa8, 0x13a8, 0x17a8, 0x1ba8, 0x1fa8,
     0x0050, 0x0450, 0x0850, 0x0c50, 0x1050, 0x1450, 0x1850, 0x1c50,
     0x00d0, 0x04d0, 0x08d0, 0x0cd0, 0x10d0, 0x14d0, 0x18d0, 0x1cd0,
     0x0150, 0x0550, 0x0950, 0x0d50, 0x1150, 0x1550, 0x1950, 0x1d50,
     0x01d0, 0x05d0, 0x09d0, 0x0dd0, 0x11d0, 0x15d0, 0x19d0, 0x1dd0,
     0x0250, 0x0650, 0x0a50, 0x0e50, 0x1250, 0x1650, 0x1a50, 0x1e50,
     0x02d0, 0x06d0, 0x0ad0, 0x0ed0, 0x12d0, 0x16d0, 0x1ad0, 0x1ed0,
     0x0350, 0x0750, 0x0b50, 0x0f50, 0x1350, 0x1750, 0x1b50, 0x1f50,
     0x03d0, 0x07d0, 0x0bd0, 0x0fd0, 0x13d0, 0x17d0, 0x1bd0, 0x1fd0
  ];

  var colors_lut;

  /**
    * This function makes the color lookup table for hires mode.
    * We make a table of 1024 * 2 * 7 entries.
    * Why? Because we assume each color byte has 10 bits
    * (8 real bits + 1 on each side) and we need different colors
    * for odd and even addresses (2) and each byte displays 7 pixels.
    */
  {
     colors_lut = new Array(256*4*2*7);
     var i,j;
     var c1,c2,c3 = 15;
     var base = 0;

     // go thru odd and even
     for (j=0; j<2; j++)
     {
        // go thru 1024 values
        for (var b1=0; b1<1024; b1++)
        {
           // see if the hi bit is set
           if ((b1 & 0x80) == 0)
           {
              c1 = 1; c2 = 12;    // red & green
           } else
           {
              c1 = 7; c2 = 9;     // blue & orange
           }
           // make a value consisting of:
           // the 8th bit, then bits 0-7, then the 9th bit
           var b = ((b1 & 0x100) >> 8) | ((b1 & 0x7f) << 1) |
                   ((b1 & 0x200) >> 1);
           // go through each pixel
           for (i=0; i<7; i++)
           {
              var c;
              // is this pixel lit?
              if (((2<<i)&b) != 0)
              {
                 // are there pixels lit on both sides of this one?
                 if (((7<<i)&b) == (7<<i))
                    // yes, make it white
                    c = 15;
                 else
                    // no, choose color based on odd/even byte
                    // and odd/even pixel column
                    c = ((((j ^ i) & 1) == 0) ? c1 : c2);
              } else
              {
                 // are there pixels lit in the previous & next
                 // column but none in this?
                 if (((5<<i)&b) == (5<<i))
                    // color this pixel
                    c = ((((j ^ i) & 1) != 0) ? c1 : c2);
                 else
                    c = 0;
              }
              colors_lut[base] = loresColor[c];
              base++;
           }
        }
     }
  }

  function drawLoresChar(x, y, b)
  {
     var i,base,adr,c;
     base = (y<<3)*XSIZE + x*7; //(x<<2) + (x<<1) + x
     c = loresColor[b & 0x0f];
     for (i=0; i<4; i++)
     {
        pixels[base] =
        pixels[base+1] =
        pixels[base+2] =
        pixels[base+3] =
        pixels[base+4] =
        pixels[base+5] =
        pixels[base+6] = c;
        base += XSIZE;
     }
     c = loresColor[b >> 4];
     for (i=0; i<4; i++)
     {
        pixels[base] =
        pixels[base+1] =
        pixels[base+2] =
        pixels[base+3] =
        pixels[base+4] =
        pixels[base+5] =
        pixels[base+6] = c;
        base += XSIZE;
     }
  }

  function drawTextChar(x, y, b, invert)
  {
     var base = (y<<3)*XSIZE + x*7; // (x<<2) + (x<<1) + x
     var on,off;
     if (invert)
     {
        on = PIXELOFF;
        off = PIXELON;
     } else
     {
        on = PIXELON;
        off = PIXELOFF;
     }

     for (var yy=0; yy<8; yy++)
     {
        var chr = apple2_charset[(b<<3)+yy];
        pixels[base] = ((chr & 64) > 0)?on:off;
        pixels[base+1] = ((chr & 32) > 0)?on:off;
        pixels[base+2] = ((chr & 16) > 0)?on:off;
        pixels[base+3] = ((chr & 8) > 0)?on:off;
        pixels[base+4] = ((chr & 4) > 0)?on:off;
        pixels[base+5] = ((chr & 2) > 0)?on:off;
        pixels[base+6] = ((chr & 1) > 0)?on:off;
        base += XSIZE;
     }
  }

  function drawHiresLines(y, maxy)
  {
     var yb = y*XSIZE;
     for (; y < maxy; y++)
     {
        var base = hires_lut[y] + (((apple.grswitch & GR_PAGE1) != 0) ? 0x4000 : 0x2000);
        if (!apple.dirty[base >> 7])
        {
           yb += XSIZE;
           continue;
        }
        var c1, c2;
        var b = 0;
        var b1 = apple.mem[base] & 0xff;
        for (var x1=0; x1<20; x1++)
        {
           var b2 = apple.mem[base+1] & 0xff;
           var b3 = apple.mem[base+2] & 0xff;
           var d1 = (((b&0x40)<<2) | b1 | b2<<9) & 0x3ff;
           for (var i=0; i<7; i++)
              pixels[yb+i] = colors_lut[d1*7+i];
           var d2 = (((b1&0x40)<<2) | b2 | b3<<9) & 0x3ff;
           for (var i=0; i<7; i++)
              pixels[yb+7+i] = colors_lut[d1*7+7168+i];
           yb += 14;
           base += 2;
           b = b2;
           b1 = b3;
        }
     }
  }

  function drawLoresLine(y)
  {
     // get the base address of this line
     var base = text_lut[y] +
                (((apple.grswitch & GR_PAGE1) != 0) ? 0x800 : 0x400);
  //		if (!dirty[base >> 7])
  //		    return;
     for (var x=0; x<40; x++)
     {
        var b = apple.mem[base+x] & 0xff;
        // if the char. changed, draw it
        if (b != textbuf[y*40+x])
        {
           drawLoresChar(x, y, b);
           textbuf[y*40+x] = b;
        }
     }
  }

  function drawTextLine(y, flash)
  {
     // get the base address of this line
     var base = text_lut[y] +
                (((apple.grswitch & GR_PAGE1) != 0) ? 0x800 : 0x400);
  //		if (!dirty[base >> 7])
  //		    return;
     for (var x=0; x<40; x++)
     {
        var b = apple.mem[base+x] & 0xff;
        var invert;
        // invert flash characters 1/2 of the time
        if (b >= 0x80)
        {
           invert = false;
        } else if (b >= 0x40)
        {
           invert = flash;
           if (flash)
              b -= 0x40;
           else
              b += 0x40;
        } else
           invert = true;
        // if the char. changed, draw it
        if (b != textbuf[y*40+x])
        {
           drawTextChar(x, y, b & 0x7f, invert);
           textbuf[y*40+x] = b;
        }
     }
  }

  this.updateScreen = function(totalrepaint)
  {
     var y;
     var flash = (new Date().getTime() % (flashInterval<<1)) > flashInterval;

     // if graphics mode changed, repaint whole screen
     if (apple.grswitch != oldgrmode)
     {
        oldgrmode = apple.grswitch;
        totalrepaint = true;
     }
     if (totalrepaint)
     {
        // clear textbuf if in text mode
        if ((apple.grswitch & GR_TXMODE) != 0 || (apple.grswitch & GR_MIXMODE) != 0)
        {
           for (y=0; y<24; y++)
              for (var x=0; x<40; x++)
                 textbuf[y*40+x] = -1;
        }
        for (var i=0; i<384; i++)
           apple.dirty[i] = true;
     }

     // first, draw top part of window
     if ((apple.grswitch & GR_TXMODE) != 0)
     {
        for (y=0; y<20; y++)
           drawTextLine(y, flash);
     } else
     {
        if ((apple.grswitch & GR_HIRES) != 0)
           drawHiresLines(0, 160);
        else
           for (y=0; y<20; y++)
              drawLoresLine(y);
     }

     // now do mixed part of window
     if ((apple.grswitch & GR_TXMODE) != 0 || (apple.grswitch & GR_MIXMODE) != 0)
     {
        for (y=20; y<24; y++)
           drawTextLine(y, flash);
     } else
     {
        if ((apple.grswitch & GR_HIRES) != 0)
           drawHiresLines(160, 192);
        else
           for (y=20; y<24; y++)
              drawLoresLine(y);
     }
     for (var i=0; i<384; i++)
        apple.dirty[i] = false;
  }
}

/*exported apple2_charset */

var apple2_charset = [
    0x00,0x1c,0x22,0x2a,0x2e,0x2c,0x20,0x1e,
    0x00,0x08,0x14,0x22,0x22,0x3e,0x22,0x22,
    0x00,0x3c,0x22,0x22,0x3c,0x22,0x22,0x3c,
    0x00,0x1c,0x22,0x20,0x20,0x20,0x22,0x1c,
    0x00,0x3c,0x22,0x22,0x22,0x22,0x22,0x3c,
    0x00,0x3e,0x20,0x20,0x3c,0x20,0x20,0x3e,
    0x00,0x3e,0x20,0x20,0x3c,0x20,0x20,0x20,
    0x00,0x1e,0x20,0x20,0x20,0x26,0x22,0x1e,
    0x00,0x22,0x22,0x22,0x3e,0x22,0x22,0x22,
    0x00,0x1c,0x08,0x08,0x08,0x08,0x08,0x1c,
    0x00,0x02,0x02,0x02,0x02,0x02,0x22,0x1c,
    0x00,0x22,0x24,0x28,0x30,0x28,0x24,0x22,
    0x00,0x20,0x20,0x20,0x20,0x20,0x20,0x3e,
    0x00,0x22,0x36,0x2a,0x2a,0x22,0x22,0x22,
    0x00,0x22,0x22,0x32,0x2a,0x26,0x22,0x22,
    0x00,0x1c,0x22,0x22,0x22,0x22,0x22,0x1c,
    0x00,0x3c,0x22,0x22,0x3c,0x20,0x20,0x20,
    0x00,0x1c,0x22,0x22,0x22,0x2a,0x24,0x1a,
    0x00,0x3c,0x22,0x22,0x3c,0x28,0x24,0x22,
    0x00,0x1c,0x22,0x20,0x1c,0x02,0x22,0x1c,
    0x00,0x3e,0x08,0x08,0x08,0x08,0x08,0x08,
    0x00,0x22,0x22,0x22,0x22,0x22,0x22,0x1c,
    0x00,0x22,0x22,0x22,0x22,0x22,0x14,0x08,
    0x00,0x22,0x22,0x22,0x2a,0x2a,0x36,0x22,
    0x00,0x22,0x22,0x14,0x08,0x14,0x22,0x22,
    0x00,0x22,0x22,0x14,0x08,0x08,0x08,0x08,
    0x00,0x3e,0x02,0x04,0x08,0x10,0x20,0x3e,
    0x00,0x3e,0x30,0x30,0x30,0x30,0x30,0x3e,
    0x00,0x00,0x20,0x10,0x08,0x04,0x02,0x00,
    0x00,0x3e,0x06,0x06,0x06,0x06,0x06,0x3e,
    0x00,0x00,0x00,0x08,0x14,0x22,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x3e,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    0x00,0x08,0x08,0x08,0x08,0x08,0x00,0x08,
    0x00,0x14,0x14,0x14,0x00,0x00,0x00,0x00,
    0x00,0x14,0x14,0x3e,0x14,0x3e,0x14,0x14,
    0x00,0x08,0x1e,0x28,0x1c,0x0a,0x3c,0x08,
    0x00,0x30,0x32,0x04,0x08,0x10,0x26,0x06,
    0x00,0x10,0x28,0x28,0x10,0x2a,0x24,0x1a,
    0x00,0x08,0x08,0x08,0x00,0x00,0x00,0x00,
    0x00,0x08,0x10,0x20,0x20,0x20,0x10,0x08,
    0x00,0x08,0x04,0x02,0x02,0x02,0x04,0x08,
    0x00,0x08,0x2a,0x1c,0x08,0x1c,0x2a,0x08,
    0x00,0x00,0x08,0x08,0x3e,0x08,0x08,0x00,
    0x00,0x00,0x00,0x00,0x00,0x08,0x08,0x10,
    0x00,0x00,0x00,0x00,0x3e,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x08,
    0x00,0x00,0x02,0x04,0x08,0x10,0x20,0x00,
    0x00,0x1c,0x22,0x26,0x2a,0x32,0x22,0x1c,
    0x00,0x08,0x18,0x08,0x08,0x08,0x08,0x1c,
    0x00,0x1c,0x22,0x02,0x0c,0x10,0x20,0x3e,
    0x00,0x3e,0x02,0x04,0x0c,0x02,0x22,0x1c,
    0x00,0x04,0x0c,0x14,0x24,0x3e,0x04,0x04,
    0x00,0x3e,0x20,0x3c,0x02,0x02,0x22,0x1c,
    0x00,0x0e,0x10,0x20,0x3c,0x22,0x22,0x1c,
    0x00,0x3e,0x02,0x04,0x08,0x10,0x10,0x10,
    0x00,0x1c,0x22,0x22,0x1c,0x22,0x22,0x1c,
    0x00,0x1c,0x22,0x22,0x1e,0x02,0x04,0x38,
    0x00,0x00,0x00,0x08,0x00,0x08,0x00,0x00,
    0x00,0x00,0x00,0x08,0x00,0x08,0x08,0x10,
    0x00,0x04,0x08,0x10,0x20,0x10,0x08,0x04,
    0x00,0x00,0x00,0x3e,0x00,0x3e,0x00,0x00,
    0x00,0x10,0x08,0x04,0x02,0x04,0x08,0x10,
    0x00,0x1c,0x22,0x04,0x08,0x08,0x00,0x08,
    0x80,0x9c,0xa2,0xaa,0xae,0xac,0xa0,0x9e,
    0x80,0x88,0x94,0xa2,0xa2,0xbe,0xa2,0xa2,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa2,0xa2,0xbc,
    0x80,0x9c,0xa2,0xa0,0xa0,0xa0,0xa2,0x9c,
    0x80,0xbc,0xa2,0xa2,0xa2,0xa2,0xa2,0xbc,
    0x80,0xbe,0xa0,0xa0,0xbc,0xa0,0xa0,0xbe,
    0x80,0xbe,0xa0,0xa0,0xbc,0xa0,0xa0,0xa0,
    0x80,0x9e,0xa0,0xa0,0xa0,0xa6,0xa2,0x9e,
    0x80,0xa2,0xa2,0xa2,0xbe,0xa2,0xa2,0xa2,
    0x80,0x9c,0x88,0x88,0x88,0x88,0x88,0x9c,
    0x80,0x82,0x82,0x82,0x82,0x82,0xa2,0x9c,
    0x80,0xa2,0xa4,0xa8,0xb0,0xa8,0xa4,0xa2,
    0x80,0xa0,0xa0,0xa0,0xa0,0xa0,0xa0,0xbe,
    0x80,0xa2,0xb6,0xaa,0xaa,0xa2,0xa2,0xa2,
    0x80,0xa2,0xa2,0xb2,0xaa,0xa6,0xa2,0xa2,
    0x80,0x9c,0xa2,0xa2,0xa2,0xa2,0xa2,0x9c,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa0,0xa0,0xa0,
    0x80,0x9c,0xa2,0xa2,0xa2,0xaa,0xa4,0x9a,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa8,0xa4,0xa2,
    0x80,0x9c,0xa2,0xa0,0x9c,0x82,0xa2,0x9c,
    0x80,0xbe,0x88,0x88,0x88,0x88,0x88,0x88,
    0x80,0xa2,0xa2,0xa2,0xa2,0xa2,0xa2,0x9c,
    0x80,0xa2,0xa2,0xa2,0xa2,0xa2,0x94,0x88,
    0x80,0xa2,0xa2,0xa2,0xaa,0xaa,0xb6,0xa2,
    0x80,0xa2,0xa2,0x94,0x88,0x94,0xa2,0xa2,
    0x80,0xa2,0xa2,0x94,0x88,0x88,0x88,0x88,
    0x80,0xbe,0x82,0x84,0x88,0x90,0xa0,0xbe,
    0x80,0xbe,0xb0,0xb0,0xb0,0xb0,0xb0,0xbe,
    0x80,0x80,0xa0,0x90,0x88,0x84,0x82,0x80,
    0x80,0xbe,0x86,0x86,0x86,0x86,0x86,0xbe,
    0x80,0x80,0x80,0x88,0x94,0xa2,0x80,0x80,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0xbe,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,
    0x80,0x88,0x88,0x88,0x88,0x88,0x80,0x88,
    0x80,0x94,0x94,0x94,0x80,0x80,0x80,0x80,
    0x80,0x94,0x94,0xbe,0x94,0xbe,0x94,0x94,
    0x80,0x88,0x9e,0xa8,0x9c,0x8a,0xbc,0x88,
    0x80,0xb0,0xb2,0x84,0x88,0x90,0xa6,0x86,
    0x80,0x90,0xa8,0xa8,0x90,0xaa,0xa4,0x9a,
    0x80,0x88,0x88,0x88,0x80,0x80,0x80,0x80,
    0x80,0x88,0x90,0xa0,0xa0,0xa0,0x90,0x88,
    0x80,0x88,0x84,0x82,0x82,0x82,0x84,0x88,
    0x80,0x88,0xaa,0x9c,0x88,0x9c,0xaa,0x88,
    0x80,0x80,0x88,0x88,0xbe,0x88,0x88,0x80,
    0x80,0x80,0x80,0x80,0x80,0x88,0x88,0x90,
    0x80,0x80,0x80,0x80,0xbe,0x80,0x80,0x80,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x88,
    0x80,0x80,0x82,0x84,0x88,0x90,0xa0,0x80,
    0x80,0x9c,0xa2,0xa6,0xaa,0xb2,0xa2,0x9c,
    0x80,0x88,0x98,0x88,0x88,0x88,0x88,0x9c,
    0x80,0x9c,0xa2,0x82,0x8c,0x90,0xa0,0xbe,
    0x80,0xbe,0x82,0x84,0x8c,0x82,0xa2,0x9c,
    0x80,0x84,0x8c,0x94,0xa4,0xbe,0x84,0x84,
    0x80,0xbe,0xa0,0xbc,0x82,0x82,0xa2,0x9c,
    0x80,0x8e,0x90,0xa0,0xbc,0xa2,0xa2,0x9c,
    0x80,0xbe,0x82,0x84,0x88,0x90,0x90,0x90,
    0x80,0x9c,0xa2,0xa2,0x9c,0xa2,0xa2,0x9c,
    0x80,0x9c,0xa2,0xa2,0x9e,0x82,0x84,0xb8,
    0x80,0x80,0x80,0x88,0x80,0x88,0x80,0x80,
    0x80,0x80,0x80,0x88,0x80,0x88,0x88,0x90,
    0x80,0x84,0x88,0x90,0xa0,0x90,0x88,0x84,
    0x80,0x80,0x80,0xbe,0x80,0xbe,0x80,0x80,
    0x80,0x90,0x88,0x84,0x82,0x84,0x88,0x90,
    0x80,0x9c,0xa2,0x84,0x88,0x88,0x80,0x88,
    0x00,0x1c,0x22,0x2a,0x2e,0x2c,0x20,0x1e,
    0x00,0x08,0x14,0x22,0x22,0x3e,0x22,0x22,
    0x00,0x3c,0x22,0x22,0x3c,0x22,0x22,0x3c,
    0x00,0x1c,0x22,0x20,0x20,0x20,0x22,0x1c,
    0x00,0x3c,0x22,0x22,0x22,0x22,0x22,0x3c,
    0x00,0x3e,0x20,0x20,0x3c,0x20,0x20,0x3e,
    0x00,0x3e,0x20,0x20,0x3c,0x20,0x20,0x20,
    0x00,0x1e,0x20,0x20,0x20,0x26,0x22,0x1e,
    0x00,0x22,0x22,0x22,0x3e,0x22,0x22,0x22,
    0x00,0x1c,0x08,0x08,0x08,0x08,0x08,0x1c,
    0x00,0x02,0x02,0x02,0x02,0x02,0x22,0x1c,
    0x00,0x22,0x24,0x28,0x30,0x28,0x24,0x22,
    0x00,0x20,0x20,0x20,0x20,0x20,0x20,0x3e,
    0x00,0x22,0x36,0x2a,0x2a,0x22,0x22,0x22,
    0x00,0x22,0x22,0x32,0x2a,0x26,0x22,0x22,
    0x00,0x1c,0x22,0x22,0x22,0x22,0x22,0x1c,
    0x00,0x3c,0x22,0x22,0x3c,0x20,0x20,0x20,
    0x00,0x1c,0x22,0x22,0x22,0x2a,0x24,0x1a,
    0x00,0x3c,0x22,0x22,0x3c,0x28,0x24,0x22,
    0x00,0x1c,0x22,0x20,0x1c,0x02,0x22,0x1c,
    0x00,0x3e,0x08,0x08,0x08,0x08,0x08,0x08,
    0x00,0x22,0x22,0x22,0x22,0x22,0x22,0x1c,
    0x00,0x22,0x22,0x22,0x22,0x22,0x14,0x08,
    0x00,0x22,0x22,0x22,0x2a,0x2a,0x36,0x22,
    0x00,0x22,0x22,0x14,0x08,0x14,0x22,0x22,
    0x00,0x22,0x22,0x14,0x08,0x08,0x08,0x08,
    0x00,0x3e,0x02,0x04,0x08,0x10,0x20,0x3e,
    0x00,0x3e,0x30,0x30,0x30,0x30,0x30,0x3e,
    0x00,0x00,0x20,0x10,0x08,0x04,0x02,0x00,
    0x00,0x3e,0x06,0x06,0x06,0x06,0x06,0x3e,
    0x00,0x00,0x00,0x08,0x14,0x22,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x3e,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
    0x00,0x08,0x08,0x08,0x08,0x08,0x00,0x08,
    0x00,0x14,0x14,0x14,0x00,0x00,0x00,0x00,
    0x00,0x14,0x14,0x3e,0x14,0x3e,0x14,0x14,
    0x00,0x08,0x1e,0x28,0x1c,0x0a,0x3c,0x08,
    0x00,0x30,0x32,0x04,0x08,0x10,0x26,0x06,
    0x00,0x10,0x28,0x28,0x10,0x2a,0x24,0x1a,
    0x00,0x08,0x08,0x08,0x00,0x00,0x00,0x00,
    0x00,0x08,0x10,0x20,0x20,0x20,0x10,0x08,
    0x00,0x08,0x04,0x02,0x02,0x02,0x04,0x08,
    0x00,0x08,0x2a,0x1c,0x08,0x1c,0x2a,0x08,
    0x00,0x00,0x08,0x08,0x3e,0x08,0x08,0x00,
    0x00,0x00,0x00,0x00,0x00,0x08,0x08,0x10,
    0x00,0x00,0x00,0x00,0x3e,0x00,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x08,
    0x00,0x00,0x02,0x04,0x08,0x10,0x20,0x00,
    0x00,0x1c,0x22,0x26,0x2a,0x32,0x22,0x1c,
    0x00,0x08,0x18,0x08,0x08,0x08,0x08,0x1c,
    0x00,0x1c,0x22,0x02,0x0c,0x10,0x20,0x3e,
    0x00,0x3e,0x02,0x04,0x0c,0x02,0x22,0x1c,
    0x00,0x04,0x0c,0x14,0x24,0x3e,0x04,0x04,
    0x00,0x3e,0x20,0x3c,0x02,0x02,0x22,0x1c,
    0x00,0x0e,0x10,0x20,0x3c,0x22,0x22,0x1c,
    0x00,0x3e,0x02,0x04,0x08,0x10,0x10,0x10,
    0x00,0x1c,0x22,0x22,0x1c,0x22,0x22,0x1c,
    0x00,0x1c,0x22,0x22,0x1e,0x02,0x04,0x38,
    0x00,0x00,0x00,0x08,0x00,0x08,0x00,0x00,
    0x00,0x00,0x00,0x08,0x00,0x08,0x08,0x10,
    0x00,0x04,0x08,0x10,0x20,0x10,0x08,0x04,
    0x00,0x00,0x00,0x3e,0x00,0x3e,0x00,0x00,
    0x00,0x10,0x08,0x04,0x02,0x04,0x08,0x10,
    0x00,0x1c,0x22,0x04,0x08,0x08,0x00,0x08,
    0x80,0x9c,0xa2,0xaa,0xae,0xac,0xa0,0x9e,
    0x80,0x88,0x94,0xa2,0xa2,0xbe,0xa2,0xa2,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa2,0xa2,0xbc,
    0x80,0x9c,0xa2,0xa0,0xa0,0xa0,0xa2,0x9c,
    0x80,0xbc,0xa2,0xa2,0xa2,0xa2,0xa2,0xbc,
    0x80,0xbe,0xa0,0xa0,0xbc,0xa0,0xa0,0xbe,
    0x80,0xbe,0xa0,0xa0,0xbc,0xa0,0xa0,0xa0,
    0x80,0x9e,0xa0,0xa0,0xa0,0xa6,0xa2,0x9e,
    0x80,0xa2,0xa2,0xa2,0xbe,0xa2,0xa2,0xa2,
    0x80,0x9c,0x88,0x88,0x88,0x88,0x88,0x9c,
    0x80,0x82,0x82,0x82,0x82,0x82,0xa2,0x9c,
    0x80,0xa2,0xa4,0xa8,0xb0,0xa8,0xa4,0xa2,
    0x80,0xa0,0xa0,0xa0,0xa0,0xa0,0xa0,0xbe,
    0x80,0xa2,0xb6,0xaa,0xaa,0xa2,0xa2,0xa2,
    0x80,0xa2,0xa2,0xb2,0xaa,0xa6,0xa2,0xa2,
    0x80,0x9c,0xa2,0xa2,0xa2,0xa2,0xa2,0x9c,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa0,0xa0,0xa0,
    0x80,0x9c,0xa2,0xa2,0xa2,0xaa,0xa4,0x9a,
    0x80,0xbc,0xa2,0xa2,0xbc,0xa8,0xa4,0xa2,
    0x80,0x9c,0xa2,0xa0,0x9c,0x82,0xa2,0x9c,
    0x80,0xbe,0x88,0x88,0x88,0x88,0x88,0x88,
    0x80,0xa2,0xa2,0xa2,0xa2,0xa2,0xa2,0x9c,
    0x80,0xa2,0xa2,0xa2,0xa2,0xa2,0x94,0x88,
    0x80,0xa2,0xa2,0xa2,0xaa,0xaa,0xb6,0xa2,
    0x80,0xa2,0xa2,0x94,0x88,0x94,0xa2,0xa2,
    0x80,0xa2,0xa2,0x94,0x88,0x88,0x88,0x88,
    0x80,0xbe,0x82,0x84,0x88,0x90,0xa0,0xbe,
    0x80,0xbe,0xb0,0xb0,0xb0,0xb0,0xb0,0xbe,
    0x80,0x80,0xa0,0x90,0x88,0x84,0x82,0x80,
    0x80,0xbe,0x86,0x86,0x86,0x86,0x86,0xbe,
    0x80,0x80,0x80,0x88,0x94,0xa2,0x80,0x80,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0xbe,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,
    0x80,0x88,0x88,0x88,0x88,0x88,0x80,0x88,
    0x80,0x94,0x94,0x94,0x80,0x80,0x80,0x80,
    0x80,0x94,0x94,0xbe,0x94,0xbe,0x94,0x94,
    0x80,0x88,0x9e,0xa8,0x9c,0x8a,0xbc,0x88,
    0x80,0xb0,0xb2,0x84,0x88,0x90,0xa6,0x86,
    0x80,0x90,0xa8,0xa8,0x90,0xaa,0xa4,0x9a,
    0x80,0x88,0x88,0x88,0x80,0x80,0x80,0x80,
    0x80,0x88,0x90,0xa0,0xa0,0xa0,0x90,0x88,
    0x80,0x88,0x84,0x82,0x82,0x82,0x84,0x88,
    0x80,0x88,0xaa,0x9c,0x88,0x9c,0xaa,0x88,
    0x80,0x80,0x88,0x88,0xbe,0x88,0x88,0x80,
    0x80,0x80,0x80,0x80,0x80,0x88,0x88,0x90,
    0x80,0x80,0x80,0x80,0xbe,0x80,0x80,0x80,
    0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x88,
    0x80,0x80,0x82,0x84,0x88,0x90,0xa0,0x80,
    0x80,0x9c,0xa2,0xa6,0xaa,0xb2,0xa2,0x9c,
    0x80,0x88,0x98,0x88,0x88,0x88,0x88,0x9c,
    0x80,0x9c,0xa2,0x82,0x8c,0x90,0xa0,0xbe,
    0x80,0xbe,0x82,0x84,0x8c,0x82,0xa2,0x9c,
    0x80,0x84,0x8c,0x94,0xa4,0xbe,0x84,0x84,
    0x80,0xbe,0xa0,0xbc,0x82,0x82,0xa2,0x9c,
    0x80,0x8e,0x90,0xa0,0xbc,0xa2,0xa2,0x9c,
    0x80,0xbe,0x82,0x84,0x88,0x90,0x90,0x90,
    0x80,0x9c,0xa2,0xa2,0x9c,0xa2,0xa2,0x9c,
    0x80,0x9c,0xa2,0xa2,0x9e,0x82,0x84,0xb8,
    0x80,0x80,0x80,0x88,0x80,0x88,0x80,0x80,
    0x80,0x80,0x80,0x88,0x80,0x88,0x88,0x90,
    0x80,0x84,0x88,0x90,0xa0,0x90,0x88,0x84,
    0x80,0x80,0x80,0xbe,0x80,0xbe,0x80,0x80,
    0x80,0x90,0x88,0x84,0x82,0x84,0x88,0x90,
    0x80,0x9c,0xa2,0x84,0x88,0x88,0x80,0x88
];

// public domain ROM
var APPLEIIGO_LZG = [
  76,90,71,0,0,48,0,0,0,5,231,30,202,84,84,1,21,25,30,52,65,80,80,76,69,73,73,71,79,32,82,79,
  77,49,46,49,255,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,3,133,109,132,110,56,165,150,229,155,133,94,
  168,165,151,229,156,170,232,152,240,35,165,150,56,229,94,133,150,176,3,198,151,56,165,148,30,3,148,176,8,198,149,144,
  4,177,150,145,148,136,208,249,52,194,198,151,198,149,202,208,242,96,25,30,128,52,27,255,255,32,0,224,25,30,67,52,
  30,52,28,25,31,174,52,31,52,30,52,28,52,4,25,63,105,52,31,52,30,52,28,52,2,25,63,103,52,15,25,31,
  137,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,26,160,32,52,28,32,
  32,160,0,52,5,25,6,40,1,16,16,12,5,19,15,6,20,32,14,15,20,32,1,22,1,9,12,1,2,12,5,25,
  16,40,198,207,210,160,205,207,210,197,160,201,206,30,3,205,193,212,201,207,206,160,208,204,197,193,211,197,160,195,204,201,
  195,203,160,30,8,160,25,8,40,212,200,197,160,193,208,30,25,201,201,199,207,160,204,207,52,129,194,197,204,207,215,30,
  28,52,10,25,6,40,52,29,52,14,76,3,224,32,88,252,162,39,189,0,223,157,128,4,202,16,247,30,3,48,223,157,
  0,5,30,195,30,78,25,5,3,96,30,3,6,30,195,144,30,25,7,30,3,76,64,224,52,65,25,30,131,52,31,52,
  31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,
  31,52,31,52,31,52,31,52,31,52,24,201,206,176,238,201,201,144,234,201,204,240,230,208,232,234,52,11,72,74,41,3,
  9,4,133,41,104,41,24,144,2,105,127,133,40,10,10,5,40,133,40,96,25,30,116,0,165,37,32,193,251,101,32,25,
  29,75,52,21,165,34,72,32,36,252,165,40,133,42,165,41,133,43,164,33,136,104,105,1,197,35,176,13,30,78,177,40,
  145,42,136,16,249,48,225,160,0,32,158,252,176,134,164,36,169,160,145,40,200,196,33,144,249,25,30,199,52,27,164,36,
  177,40,72,41,63,9,64,145,40,104,108,56,25,19,27,32,12,253,32,165,251,52,161,201,155,240,243,25,28,141,52,6,
  32,142,253,165,51,32,237,253,162,1,138,240,243,202,32,53,253,201,149,208,2,177,40,201,224,144,2,41,223,157,0,2,
  201,141,208,178,32,156,252,169,141,208,91,164,61,166,60,30,39,32,64,249,160,0,169,173,76,237,253,25,28,87,52,31,
  52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,31,52,28,52,7,169,0,133,28,165,230,
  133,27,160,0,132,26,165,28,145,26,32,126,244,200,208,246,230,27,165,27,41,31,208,238,96,133,226,134,224,132,225,72,
  41,192,133,38,74,74,5,38,133,38,104,133,39,10,10,10,38,39,52,66,102,38,165,39,41,31,5,230,133,39,138,192,
  0,240,5,160,35,105,4,200,233,7,176,251,132,229,170,189,185,244,133,48,152,74,165,228,133,28,176,21,28,0,35,52,
  4,10,201,192,16,6,165,28,73,127,133,28,25,254,218,52,31,52,31,52,31,52,31,52,31,52,31,52,28,52,10,74,
  8,32,71,248,40,169,15,144,2,105,224,133,46,177,38,69,48,37,46,81,38,145,38,96,32,0,248,196,44,176,17,200,
  32,14,248,144,246,105,1,72,30,8,104,197,45,144,245,96,160,47,208,2,160,39,132,45,160,39,169,0,133,48,32,40,
  248,136,16,246,96,21,5,4,126,39,21,6,4,126,38,10,10,25,130,52,96,165,48,24,105,3,41,15,133,48,10,52,
  1,5,48,133,48,25,103,223,144,4,74,52,1,41,15,25,107,240,168,74,144,9,106,176,16,201,162,240,12,41,135,74,
  170,189,98,249,32,121,248,208,4,160,128,169,0,170,189,166,249,133,46,41,3,133,47,152,41,143,170,152,160,3,224,138,
  240,11,74,144,8,74,74,9,32,136,208,250,200,136,208,242,25,159,59,52,31,52,31,52,20,216,32,132,254,32,47,251,
  32,147,254,32,137,254,173,88,192,173,90,192,173,93,192,173,95,192,173,255,207,44,16,192,216,32,58,255,32,96,251,169,
  0,133,0,169,198,133,1,108,25,30,111,52,29,21,3,19,108,221,219,199,207,25,10,13,173,112,192,160,0,234,234,189,
  100,192,16,4,200,208,248,136,96,169,0,133,72,173,86,192,173,84,192,173,81,192,169,0,240,11,173,80,192,173,83,192,
  32,54,248,169,20,133,34,30,22,32,169,40,133,33,169,24,133,35,169,23,133,37,76,34,252,32,88,252,160,9,185,8,
  251,153,14,4,136,208,247,96,173,243,3,73,165,141,244,3,96,201,141,208,24,172,0,192,16,19,192,147,208,15,44,16,
  192,30,68,251,192,131,240,3,30,4,76,253,251,25,12,148,21,29,7,248,40,133,40,96,201,135,208,18,169,64,32,168,
  252,160,192,169,12,52,193,173,48,192,136,208,245,96,164,36,145,40,230,36,165,36,197,33,176,102,96,201,160,176,239,168,
  16,236,201,141,240,90,201,138,52,97,136,208,201,198,36,16,232,165,33,133,36,198,36,165,34,197,37,176,11,198,37,21,
  28,7,248,0,72,32,36,252,32,158,252,160,0,104,105,0,197,35,144,240,176,202,165,34,133,37,160,0,132,36,240,228,
  169,0,133,36,230,30,62,30,16,182,198,37,21,29,7,248,21,6,7,248,56,72,233,1,208,252,104,52,129,246,96,230,
  66,208,2,230,67,165,60,197,62,165,61,229,63,230,60,30,6,61,25,125,244,52,18,21,13,7,248,230,78,208,2,230,
  79,44,0,192,16,245,145,40,173,0,192,44,16,192,96,21,10,7,248,254,96,165,50,72,169,255,133,50,189,0,2,32,
  237,253,104,30,129,201,136,240,29,201,152,240,10,224,248,144,3,32,58,255,232,208,19,169,220,30,21,21,10,7,248,254,
  21,30,7,248,52,27,0,72,25,162,88,32,229,253,104,41,15,9,176,201,186,144,2,105,6,108,54,0,201,160,144,2,
  37,50,132,53,72,32,120,251,104,164,53,25,49,47,64,25,10,5,25,11,24,177,60,145,66,32,180,252,144,247,25,190,
  97,52,1,160,63,208,2,160,255,132,50,25,98,82,62,162,56,160,27,208,8,30,130,54,160,240,165,62,41,15,240,6,
  9,192,160,0,240,2,169,253,148,0,149,1,96,234,234,76,0,21,31,22,104,52,6,169,135,76,237,253,165,72,72,165,
  69,166,70,164,71,25,110,22,25,62,27,52,30,52,14,245,3,251,3,98,250,98,250
];