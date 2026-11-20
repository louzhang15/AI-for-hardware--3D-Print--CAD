// Sonar + PCA9685 robot (Arduino IDE, board: ESP32 Dev Module, FQBN esp32:esp32:esp32)
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <NewPing.h>

#define TRIG_PIN 5      // sonar trigger
#define ECHO_PIN 18
const int SDA_PIN = 4;  // I2C data -- this disagrees with the map (GPIO21)
constexpr uint8_t SCL_PIN = 22;
static const int BUZZER_PIN = 27;
// #define OLD_PIN 99   <- commented out, must be ignored
/* const int GHOST_PIN = 33;
   pinMode(34, OUTPUT); */
const char *msg = "pinMode(12, OUTPUT)";  // string, must be ignored
#define BAUD 115200

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver();
NewPing sonar(TRIG_PIN, ECHO_PIN, 200);

void setup() {
  Serial.begin(BAUD);
  Wire.begin(SDA_PIN, SCL_PIN);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(13, OUTPUT);
  pwm.begin();
}

void loop() {
  int raw = analogRead(A0);
  digitalWrite(BUZZER_PIN, raw > 512);
}
