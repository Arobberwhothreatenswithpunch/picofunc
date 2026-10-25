// Switching signal source for half-bridge inverters (IR2302 IN + shared active-low SD)
//   3P : U/V/W sine PWM (open loop), DC excitation
//   1P : U/V legs as a full bridge, unipolar PWM, sine test tone or streamed audio
#pragma once
#include <Arduino.h>

void invInit(uint32_t sysHz);
void invPoll();                               // call every loop(): ramps, timeouts, e-stop watch
void invHandleCommand();                      // remaining strtok() tokens after "INV"
void invReport(bool optional = false);        // print "OK INV ..." status line (optional: may be skipped while streaming)
void invAudioData(const int16_t *s, size_t n);
void invAudioBadFrame();                      // damaged audio frame dropped (checksum / length)
void invOnHostDisconnect();                   // USB DTR dropped -> safe stop

bool invActive();                             // SD is high (switching)
bool invFault();

// for a future position sensor: override / read the electrical angle (2^32 = 360 deg)
void invSetTheta(uint32_t theta);
uint32_t invGetTheta();
