#include <Arduino.h>
#include <Wire.h>

// Match projects/robot-arm.json. The external 1 kΩ resistor holds OE high.
constexpr int SDA_PIN = 21;
constexpr int SCL_PIN = 22;
constexpr int OE_PIN = 23;
constexpr uint8_t PCA9685_ADDRESS = 0x40;
constexpr uint8_t MODE1_REGISTER = 0x00;

void setup() {
  pinMode(OE_PIN, INPUT);
  Serial.begin(115200);
  delay(500);

  Serial.println("Wiremap arm bring-up: keep the separate servo supply disconnected.");
  if (digitalRead(OE_PIN) != HIGH) {
    Serial.println("OE is low. Check the external pull-up and measure OE before continuing.");
    return;
  }

  if (!Wire.begin(SDA_PIN, SCL_PIN, 100000)) {
    Serial.println("Could not initialize ESP32 I2C.");
    return;
  }

  Wire.beginTransmission(PCA9685_ADDRESS);
  Wire.write(MODE1_REGISTER);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(PCA9685_ADDRESS, uint8_t{1}) != 1) {
    Serial.println("No register response at 0x40. Check VCC, ground, SDA, SCL and address straps.");
    return;
  }

  Serial.printf("I2C response at 0x40. MODE1 = 0x%02X. OE remains an input.\n", Wire.read());
}

void loop() {
  delay(1000);
}
