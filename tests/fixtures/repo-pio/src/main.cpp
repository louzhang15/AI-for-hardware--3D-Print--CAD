#include <Arduino.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include "pins.h"

Servo base;
Servo arm;

void setup() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  base.attach(SERVO_BASE_PIN);
  arm.attach(SERVO_ARM_PIN, 500, 2400);
}

void loop() {}
