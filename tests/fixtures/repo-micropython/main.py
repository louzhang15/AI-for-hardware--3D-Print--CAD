# MicroPython on a Raspberry Pi Pico (rp2)
from machine import Pin, I2C, PWM, ADC
import ssd1306
import time

LED_PIN = 15   # external LED
SERVO = 16

led = Pin(LED_PIN, Pin.OUT)
onboard = Pin("LED", Pin.OUT)
i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=400000)
servo = PWM(Pin(SERVO))
pot = ADC(26)
s = "Pin(99)"  # string, ignored
# Pin(98) in a comment, ignored

oled = ssd1306.SSD1306_I2C(128, 64, i2c)
while True:
    led.toggle()
    time.sleep(0.5)
