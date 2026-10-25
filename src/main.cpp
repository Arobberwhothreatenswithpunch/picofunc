// Simple function generator for YD-RP2040 (controlled over USB serial)
//
//   CH1 PWM  : GPIO0 = PWM out, GPIO1 = complementary (inverted) out
//              ~12 Hz and up -> hardware PWM, below that -> timer-driven software PWM
//   CH2 WAVE : GPIO2 = +, GPIO3 = - (differential pair, experimental)
//              PWM carrier whose duty is updated by DMA from a waveform table.
//              Put an RC low-pass filter on each pin to get an analog waveform.
//   INV      : GPIO4/6/8 = U/V/W IN, GPIO10 = shared SD (active low), GPIO11 = e-stop
//              switching signals for IR2302 half bridges (see inverter.cpp)
//   Status   : onboard WS2812B (GPIO23)  off / green=PWM / blue=WAVE / cyan=both
//              orange = inverter switching, red = inverter fault
//
// Protocol (115200, one command per line, case-insensitive):
//   ID | STATUS
//   PWM <freq_hz> <duty_pct> | PWM OFF
//   WAVE <SINE|TRI|SAW|SQR> <freq_hz> <amp_pct> <offset_pct> | WAVE OFF
//   INV ...  (see inverter.cpp)
// Binary frame (audio): 0x02 0x5A len_lo len_hi <int16 LE PCM> sum_lo sum_hi
// Replies: "OK ..." with key=value pairs, or "ERR <reason>".

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include "hardware/pwm.h"
#include "hardware/dma.h"
#include "hardware/gpio.h"
#include "hardware/clocks.h"
#include "pico/time.h"
#include "inverter.h"

#define FW_ID "FGEN-RP2040 v2"

// ---- pins ----
#define PWM_PIN_A   0
#define PWM_PIN_B   1
#define WAVE_PIN_P  2
#define WAVE_PIN_N  3
#define LED_PIN     23

// ---- limits ----
#define PWM_F_MIN   0.1
#define PWM_F_MAX   25e6      // TOP+1 = 8 at 200 MHz (12.5 % duty steps)
#define WAVE_TOP    511       // 9-bit carrier: 200 MHz / 512 = 390.6 kHz
#define WAVE_N_MAX  4096
#define WAVE_N_MIN  16

Adafruit_NeoPixel pixel(1, LED_PIN, NEO_GRB + NEO_KHZ800);
static uint32_t sysHz;

// =====================================================================
// CH1: PWM
// =====================================================================
enum PwmMode { PWM_OFF, PWM_HW, PWM_SW, PWM_DC };

static struct {
  PwmMode mode = PWM_OFF;
  double freq = 0, duty = 0;      // actual values
  uint32_t top = 0, div16 = 16;   // HW details
  bool clamped = false;
} pwmState;

static uint pwmSlice;

// software PWM (low frequency)
static alarm_id_t swAlarm = 0;
static volatile int64_t swHighUs, swLowUs;
static volatile bool swLevel;

static int64_t swPwmCallback(alarm_id_t, void *) {
  swLevel = !swLevel;
  gpio_put(PWM_PIN_A, swLevel);
  gpio_put(PWM_PIN_B, !swLevel);
  // positive value = reschedule relative to the previous target time (no drift)
  return swLevel ? swHighUs : swLowUs;
}

static void pwmStopAll() {
  if (swAlarm > 0) {
    cancel_alarm(swAlarm);
    swAlarm = 0;
  }
  pwm_set_enabled(pwmSlice, false);
  gpio_set_function(PWM_PIN_A, GPIO_FUNC_SIO);
  gpio_set_function(PWM_PIN_B, GPIO_FUNC_SIO);
  gpio_set_dir(PWM_PIN_A, GPIO_OUT);
  gpio_set_dir(PWM_PIN_B, GPIO_OUT);
  gpio_put(PWM_PIN_A, 0);
  gpio_put(PWM_PIN_B, 0);
}

static void pwmOff() {
  pwmStopAll();
  pwmState.mode = PWM_OFF;
}

static void pwmSet(double freq, double duty) {
  pwmState.clamped = false;
  if (freq < PWM_F_MIN) { freq = PWM_F_MIN; pwmState.clamped = true; }
  if (freq > PWM_F_MAX) { freq = PWM_F_MAX; pwmState.clamped = true; }
  if (duty < 0) { duty = 0; pwmState.clamped = true; }
  if (duty > 100) { duty = 100; pwmState.clamped = true; }

  pwmStopAll();

  // lowest frequency the hardware divider can reach
  double hwMin = (double)sysHz / (65535.0 * (255.0 + 15.0 / 16.0));

  if (freq >= hwMin * 1.001) {
    double period = (double)sysHz / freq;  // in sys clock cycles
    uint32_t div16 = 16;
    if (period > 65535.0) {  // CC must hold TOP+1 for 100 % duty
      div16 = (uint32_t)ceil(period * 16.0 / 65535.0);
      if (div16 > 255 * 16 + 15) div16 = 255 * 16 + 15;
    }
    uint32_t topPlus1 = (uint32_t)lround(period * 16.0 / div16);
    if (topPlus1 < 2) topPlus1 = 2;
    if (topPlus1 > 65535) topPlus1 = 65535;
    uint32_t level = (uint32_t)lround(duty / 100.0 * topPlus1);

    pwm_config cfg = pwm_get_default_config();
    pwm_config_set_clkdiv_int_frac(&cfg, div16 >> 4, div16 & 0xF);
    pwm_config_set_wrap(&cfg, topPlus1 - 1);
    pwm_config_set_output_polarity(&cfg, false, true);  // B = complement of A
    pwm_init(pwmSlice, &cfg, false);
    pwm_set_both_levels(pwmSlice, level, level);
    pwm_set_counter(pwmSlice, 0);
    gpio_set_function(PWM_PIN_A, GPIO_FUNC_PWM);
    gpio_set_function(PWM_PIN_B, GPIO_FUNC_PWM);
    pwm_set_enabled(pwmSlice, true);

    pwmState.mode = PWM_HW;
    pwmState.top = topPlus1 - 1;
    pwmState.div16 = div16;
    pwmState.freq = (double)sysHz * 16.0 / div16 / topPlus1;
    pwmState.duty = 100.0 * level / topPlus1;
    return;
  }

  // software PWM below the hardware range
  pwmState.freq = freq;
  pwmState.duty = duty;
  pwmState.top = 0;
  pwmState.div16 = 0;
  if (duty <= 0.0 || duty >= 100.0) {
    gpio_put(PWM_PIN_A, duty >= 100.0);
    gpio_put(PWM_PIN_B, duty < 100.0);
    pwmState.mode = PWM_DC;
    return;
  }
  int64_t periodUs = llround(1e6 / freq);
  swHighUs = llround(periodUs * duty / 100.0);
  if (swHighUs < 1) swHighUs = 1;
  swLowUs = periodUs - swHighUs;
  if (swLowUs < 1) swLowUs = 1;
  pwmState.duty = 100.0 * swHighUs / (swHighUs + swLowUs);
  swLevel = true;
  gpio_put(PWM_PIN_A, 1);
  gpio_put(PWM_PIN_B, 0);
  swAlarm = add_alarm_in_us(swHighUs, swPwmCallback, nullptr, true);
  pwmState.mode = PWM_SW;
}

// =====================================================================
// CH2: WAVE (PWM + DMA, experimental)
// =====================================================================
enum WaveType { W_SINE, W_TRI, W_SAW, W_SQR };
static const char *WAVE_NAMES[] = {"SINE", "TRI", "SAW", "SQR"};

static uint32_t waveTable[WAVE_N_MAX] __attribute__((aligned(4)));
static uint32_t *waveTableAddr = waveTable;  // read by the control DMA channel
static int dmaData = -1, dmaCtrl = -1, dmaTimer = -1;
static uint waveSlice;

static struct {
  bool on = false;
  WaveType type = W_SINE;
  double freq = 0, fs = 0, amp = 0, ofs = 0;
  uint32_t n = 0;
  bool clamped = false;
} waveState;

static void waveStop() {
  // dma_channel_abort() can hang on a channel stalled on its DREQ, so instead:
  // 1) break the data -> ctrl chain, 2) let the remaining transfers drain at full
  // speed, 3) wait until both channels are idle.
  uint32_t ctrl = dma_hw->ch[dmaData].al1_ctrl;  // al1_ctrl: write does not trigger
  ctrl = (ctrl & ~DMA_CH0_CTRL_TRIG_CHAIN_TO_BITS) | ((uint32_t)dmaData << DMA_CH0_CTRL_TRIG_CHAIN_TO_LSB);
  dma_hw->ch[dmaData].al1_ctrl = ctrl;
  dma_timer_set_fraction(dmaTimer, 1, 1);
  absolute_time_t limit = make_timeout_time_ms(20);
  while ((dma_channel_is_busy(dmaData) || dma_channel_is_busy(dmaCtrl)) &&
         !time_reached(limit)) {
    tight_loop_contents();
  }
  dma_timer_set_fraction(dmaTimer, 0, 0);
  pwm_set_enabled(waveSlice, false);
  gpio_set_function(WAVE_PIN_P, GPIO_FUNC_SIO);
  gpio_set_function(WAVE_PIN_N, GPIO_FUNC_SIO);
  gpio_set_dir(WAVE_PIN_P, GPIO_OUT);
  gpio_set_dir(WAVE_PIN_N, GPIO_OUT);
  gpio_put(WAVE_PIN_P, 0);
  gpio_put(WAVE_PIN_N, 0);
  waveState.on = false;
}

// best X/Y (X <= Y <= 65535) approximating r in (0, 1]
// continued fractions + best semiconvergent (same as Python Fraction.limit_denominator)
static void bestFraction(double r, uint32_t &bx, uint32_t &by) {
  const uint64_t LIM = 65535;
  uint64_t p0 = 0, q0 = 1, p1 = 1, q1 = 0;
  double x = r;
  for (int i = 0; i < 64; i++) {
    double a = floor(x);
    uint64_t ai = (uint64_t)a;
    uint64_t q2 = ai * q1 + q0;
    if (q2 > LIM) {
      uint64_t k = (LIM - q0) / q1;
      uint64_t ps = k * p1 + p0, qs = k * q1 + q0;
      if (fabs((double)ps / qs - r) <= fabs((double)p1 / q1 - r)) { p1 = ps; q1 = qs; }
      break;
    }
    uint64_t p2 = ai * p1 + p0;
    p0 = p1; q0 = q1; p1 = p2; q1 = q2;
    double f = x - a;
    if (f < 1e-15) break;
    x = 1.0 / f;
  }
  if (p1 < 1) { p1 = 1; q1 = LIM; }
  bx = (uint32_t)p1;
  by = (uint32_t)q1;
}

static bool waveSet(WaveType type, double freq, double amp, double ofs, String &err) {
  waveState.clamped = false;
  if (amp < 0) { amp = 0; waveState.clamped = true; }
  if (amp > 100) { amp = 100; waveState.clamped = true; }
  if (ofs < 0) { ofs = 0; waveState.clamped = true; }
  if (ofs > 100) { ofs = 100; waveState.clamped = true; }

  const double carrier = (double)sysHz / (WAVE_TOP + 1);
  const double fMax = carrier / WAVE_N_MIN;
  const double fMin = (double)sysHz / 65535.0 / WAVE_N_MAX;
  if (freq > fMax) { freq = fMax; waveState.clamped = true; }
  if (freq < fMin) { freq = fMin; waveState.clamped = true; }

  uint32_t n = (uint32_t)floor(carrier / freq);
  if (n > WAVE_N_MAX) n = WAVE_N_MAX;
  if (n < WAVE_N_MIN) n = WAVE_N_MIN;
  double fs = freq * n;
  if (fs > sysHz) { err = "sample rate too high"; return false; }

  waveStop();

  // build table: y = ofs + amp/2 * s(phase), s in [-1, 1]
  const uint32_t full = WAVE_TOP + 1;
  for (uint32_t i = 0; i < n; i++) {
    double ph = (double)i / n;  // 0..1
    double s;
    switch (type) {
      case W_SINE: s = sin(2.0 * M_PI * ph); break;
      case W_TRI:  s = ph < 0.25 ? 4 * ph : (ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4); break;
      case W_SAW:  s = 2 * ph - 1; break;
      default:     s = ph < 0.5 ? 1 : -1; break;
    }
    double y = ofs / 100.0 + amp / 200.0 * s;
    if (y < 0) y = 0;
    if (y > 1) y = 1;
    uint32_t v = (uint32_t)lround(y * full);
    waveTable[i] = (v << 16) | v;  // same level to A and B (B is inverted)
  }

  // carrier PWM
  pwm_config cfg = pwm_get_default_config();
  pwm_config_set_clkdiv_int(&cfg, 1);
  pwm_config_set_wrap(&cfg, WAVE_TOP);
  pwm_config_set_output_polarity(&cfg, false, true);
  pwm_init(waveSlice, &cfg, false);
  pwm_set_both_levels(waveSlice, waveTable[0] & 0xFFFF, waveTable[0] & 0xFFFF);
  gpio_set_function(WAVE_PIN_P, GPIO_FUNC_PWM);
  gpio_set_function(WAVE_PIN_N, GPIO_FUNC_PWM);

  // sample pacing timer
  uint32_t x, y;
  bestFraction(fs / sysHz, x, y);
  fs = (double)sysHz * x / y;

  // data channel: table -> CC register, paced by the DMA timer, then chains to ctrl
  dma_channel_config dc = dma_channel_get_default_config(dmaData);
  channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
  channel_config_set_read_increment(&dc, true);
  channel_config_set_write_increment(&dc, false);
  channel_config_set_dreq(&dc, dma_get_timer_dreq(dmaTimer));
  channel_config_set_chain_to(&dc, dmaCtrl);
  dma_channel_configure(dmaData, &dc, &pwm_hw->slice[waveSlice].cc, waveTable, n, false);

  // control channel: rewrites the data channel's read address and retriggers it
  dma_channel_config cc = dma_channel_get_default_config(dmaCtrl);
  channel_config_set_transfer_data_size(&cc, DMA_SIZE_32);
  channel_config_set_read_increment(&cc, false);
  channel_config_set_write_increment(&cc, false);
  dma_channel_configure(dmaCtrl, &cc, &dma_hw->ch[dmaData].al3_read_addr_trig,
                        &waveTableAddr, 1, false);

  dma_timer_set_fraction(dmaTimer, x, y);
  pwm_set_enabled(waveSlice, true);
  dma_channel_start(dmaCtrl);

  waveState.on = true;
  waveState.type = type;
  waveState.n = n;
  waveState.fs = fs;
  waveState.freq = fs / n;
  waveState.amp = amp;
  waveState.ofs = ofs;
  return true;
}

// =====================================================================
// status LED / reporting / command parser
// =====================================================================
static void updateLed() {
  static uint32_t last = 0xFFFFFFFF;
  bool p = pwmState.mode != PWM_OFF, w = waveState.on;
  uint32_t c = pixel.Color(0, p ? 40 : 0, w ? 40 : 0);
  if (invFault()) c = pixel.Color(60, 0, 0);
  else if (invActive()) c = pixel.Color(50, 18, 0);
  if (c == last) return;
  last = c;
  pixel.setPixelColor(0, c);
  pixel.show();
}

static void reportPwm() {
  if (pwmState.mode == PWM_OFF) {
    Serial.println("OK PWM OFF");
    return;
  }
  const char *mode = pwmState.mode == PWM_HW ? "HW" : (pwmState.mode == PWM_SW ? "SW" : "DC");
  // printf here has no float support, so format doubles with String()
  Serial.printf("OK PWM ON f=%s duty=%s mode=%s top=%lu div=%s steps=%lu clamped=%d\n",
                String(pwmState.freq, 6).c_str(), String(pwmState.duty, 4).c_str(), mode,
                (unsigned long)pwmState.top, String(pwmState.div16 / 16.0, 4).c_str(),
                (unsigned long)(pwmState.mode == PWM_HW ? pwmState.top + 1 : 0),
                pwmState.clamped ? 1 : 0);
}

static void reportWave() {
  if (!waveState.on) {
    Serial.println("OK WAVE OFF");
    return;
  }
  Serial.printf("OK WAVE ON type=%s f=%s n=%lu fs=%s carrier=%s amp=%s ofs=%s clamped=%d\n",
                WAVE_NAMES[waveState.type], String(waveState.freq, 6).c_str(),
                (unsigned long)waveState.n, String(waveState.fs, 3).c_str(),
                String((double)sysHz / (WAVE_TOP + 1), 1).c_str(),
                String(waveState.amp, 2).c_str(), String(waveState.ofs, 2).c_str(),
                waveState.clamped ? 1 : 0);
}

static bool parseNum(char *tok, double &out) {
  if (!tok) return false;
  char *end;
  out = strtod(tok, &end);
  return end != tok;
}

static void handleLine(char *line) {
  for (char *p = line; *p; p++) *p = toupper((unsigned char)*p);
  char *cmd = strtok(line, " \t");
  if (!cmd) return;

  if (!strcmp(cmd, "ID")) {
    Serial.printf("OK ID %s sys=%lu inv=1\n", FW_ID, (unsigned long)sysHz);
  } else if (!strcmp(cmd, "STATUS")) {
    reportPwm();
    reportWave();
    invReport();
  } else if (!strcmp(cmd, "INV")) {
    invHandleCommand();
  } else if (!strcmp(cmd, "PWM")) {
    char *a = strtok(nullptr, " \t");
    double f, d;
    if (a && !strcmp(a, "OFF")) {
      pwmOff();
      reportPwm();
    } else if (parseNum(a, f) && parseNum(strtok(nullptr, " \t"), d)) {
      pwmSet(f, d);
      reportPwm();
    } else {
      Serial.println("ERR usage: PWM <freq_hz> <duty_pct> | PWM OFF");
    }
  } else if (!strcmp(cmd, "WAVE")) {
    char *a = strtok(nullptr, " \t");
    if (a && !strcmp(a, "OFF")) {
      waveStop();
      reportWave();
    } else {
      int type = -1;
      for (int i = 0; a && i < 4; i++)
        if (!strcmp(a, WAVE_NAMES[i])) type = i;
      double f, amp = 100, ofs = 50;
      char *tf = strtok(nullptr, " \t");
      char *ta = strtok(nullptr, " \t");
      char *to = strtok(nullptr, " \t");
      if (type < 0 || !parseNum(tf, f) || (ta && !parseNum(ta, amp)) || (to && !parseNum(to, ofs))) {
        Serial.println("ERR usage: WAVE <SINE|TRI|SAW|SQR> <freq_hz> [amp_pct] [offset_pct] | WAVE OFF");
      } else {
        String err;
        if (waveSet((WaveType)type, f, amp, ofs, err)) reportWave();
        else Serial.printf("ERR %s\n", err.c_str());
      }
    }
  } else {
    Serial.println("ERR unknown command");
  }
  updateLed();
}

// =====================================================================
void setup() {
  sysHz = clock_get_hz(clk_sys);
  invInit(sysHz);          // first: inverter SD low, IN low
  Serial.begin(115200);

  pwmSlice = pwm_gpio_to_slice_num(PWM_PIN_A);
  waveSlice = pwm_gpio_to_slice_num(WAVE_PIN_P);
  gpio_init(PWM_PIN_A);
  gpio_init(PWM_PIN_B);
  gpio_init(WAVE_PIN_P);
  gpio_init(WAVE_PIN_N);

  dmaData = dma_claim_unused_channel(true);
  dmaCtrl = dma_claim_unused_channel(true);
  dmaTimer = dma_claim_unused_timer(true);

  pwmOff();
  waveStop();

  pixel.begin();
  updateLed();
  rp2040.wdt_begin(500);   // firmware hang -> reset -> SD pulled low externally
}

// text lines and binary audio frames share the same stream
//   frame: 0x02 0x5A len_lo len_hi <len bytes int16 LE PCM> sum_lo sum_hi  (sum = 16-bit sum of payload bytes)
// The 2-byte marker and checksum let the parser drop damaged frames and find the next real header,
// so a stalled / partly lost frame can never be played as noise or read as text.
#define FRAME_MAGIC    0x5A
#define FRAME_TIMEOUT  1000      // ms without a byte inside a frame -> give up and resync

static void readSerial() {
  static char buf[128];
  static size_t len = 0;
  static bool junk = false;             // non-printable byte in the current text line
  static uint16_t frame[2048];          // int16 samples
  enum { F_TEXT, F_STX, F_LEN_LO, F_LEN_HI, F_DATA, F_SUM_LO, F_SUM_HI };
  static uint8_t fState = F_TEXT;
  static size_t fNeed = 0, fGot = 0;
  static uint16_t fSum = 0, fSumRx = 0;
  static uint32_t fLast = 0;

  if (fState != F_TEXT && millis() - fLast > FRAME_TIMEOUT) fState = F_TEXT;
  while (Serial.available()) {
    fLast = millis();
    if (fState == F_DATA) {
      size_t n = Serial.available();
      if (n > fNeed - fGot) n = fNeed - fGot;
      uint8_t *dst = (uint8_t *)frame + fGot;
      size_t got = Serial.readBytes((char *)dst, n);
      for (size_t k = 0; k < got; k++) fSum += dst[k];
      fGot += got;
      if (fGot >= fNeed) fState = F_SUM_LO;
      continue;
    }
    int c = Serial.read();
    if (c < 0) break;
    switch (fState) {
      case F_STX:
        if (c == FRAME_MAGIC) { fState = F_LEN_LO; len = 0; junk = false; continue; }
        fState = F_TEXT;          // lone 0x02: treat as junk text below
        junk = true;
        break;
      case F_LEN_LO: fNeed = c; fState = F_LEN_HI; continue;
      case F_LEN_HI:
        fNeed |= (size_t)c << 8;
        fGot = 0; fSum = 0;
        if (fNeed == 0 || fNeed > sizeof(frame) || (fNeed & 1)) { invAudioBadFrame(); fState = F_TEXT; }
        else fState = F_DATA;
        continue;
      case F_SUM_LO: fSumRx = c; fState = F_SUM_HI; continue;
      case F_SUM_HI:
        fSumRx |= (uint16_t)c << 8;
        if (fSumRx == fSum) invAudioData((const int16_t *)frame, fNeed / 2);
        else invAudioBadFrame();
        fState = F_TEXT;
        continue;
      default:
        break;
    }
    if (c == 0x02) { fState = F_STX; continue; }
    if (c == '\r' || c == '\n') {
      // lines containing binary junk (left over from a lost frame) are dropped silently
      if (len && !junk) {
        buf[len] = 0;
        handleLine(buf);
      }
      len = 0;
      junk = false;
    } else if (c < 0x20 || c > 0x7E) {
      junk = true;
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    }
  }
}

void loop() {
  static bool hostWasConnected = false;
  bool host = (bool)Serial;   // DTR
  if (hostWasConnected && !host) invOnHostDisconnect();
  hostWasConnected = host;

  readSerial();
  invPoll();
  updateLed();
  rp2040.wdt_reset();
}
