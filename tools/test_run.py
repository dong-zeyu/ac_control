import os
import subprocess
import fcntl
import struct

def generate_ac_code_lsb(
    power_on=True, 
    power_action=None,  # None, 'on', 'off', 'maintain', 'cancel_timer'
    temp_c=24.0, 
    measured_temp_c=24.0, 
    mode='cooling',     # 工作模式: 'cooling', 'auto', 'heating', 'dehumidify'
    fan_speed='auto',   # 风速: 'auto', 'low', 'medium'/'med', 'high'
    flap='auto',        # 导风叶片/摆风: 'auto', 'swing'/'louver', 1..6 (1=底端, 6=顶端)
    night_setback=False,# 夜间节能/睡眠模式开关 (Night Setback)
    high_power=False,   # 强力模式开关 (High Power / Turbo)
    ion_mode=False,     # 负离子/空气净化开关 (ION Mode)
    quiet_mode=False,   # 安静模式开关
    timer_mode=None,    # 定时模式: None, 'on', 'off', 'combo'
    timer_on_hours=0,
    timer_on_minutes=0,
    timer_off_hours=0,
    timer_off_minutes=0,
    current_time_hours=12,
    current_time_minutes=0
):
    """
    AEHA Air Conditioner Infrared Protocol Code Generator (19 Bytes / 152 Bits).
    Complete specification and bit-mapping details are documented in PROTOCOL.md.

    :param power_on: True = Unit ON, False = Unit OFF
    :param power_action: None, 'on', 'off', 'maintain', 'cancel_timer'
    :param temp_c: Target temperature in Celsius (0.5°C resolution, base 4.0°C)
    :param measured_temp_c: Ambient / Room temperature in Celsius
    :param mode: 'cooling', 'auto', 'heating', 'dehumidify'
    :param fan_speed: 'auto', 'low', 'medium', 'high'
    :param flap: 'auto', 'swing'/'louver', or 1..6 (1=bottom, 6=top)
    :param night_setback: True = Night Setback / Sleep Mode ON, False = OFF
    :param high_power: True = High Power / Turbo mode ON, False = OFF
    :param ion_mode: True = Negative Ion / Air Purifier ON, False = OFF
    :param quiet_mode: True = Silent fan mode ON, False = OFF
    :param timer_mode: None, 'on', 'off', 'combo'
    """
    base_bytes = [
        "00000010", "00000000", "00101000", "00000001", 
        "01110110", "10000001", "00010100", "11110111", 
        "11000000", "00010010", "00010001", "01101011", 
        "11000000", "10010000", "00000000", "10000000", 
        "00000000", "00000000"
    ]
    
    # 转换为数组以便进行比特位操控
    b6 = ['0'] * 8
    
    if timer_mode:
        b6[0:2] = ['0', '0'] # PP = 00 (定时器模式，不直接触发电源动作)
        b9_power_bit = '1' if power_on else '0' # Q: 维持实际物理状态
        
        if timer_mode == 'on':
            b6[4:6] = ['0', '1']
        elif timer_mode == 'off':
            b6[4:6] = ['1', '0']
        elif timer_mode == 'combo':
            b6[4:6] = ['0', '1'] 
    else:
        if power_action in ['maintain', 'cancel_timer']:
            b6[0:2] = ['0', '0']
            b9_power_bit = '1' if power_on else '0'
        elif power_action == 'on' or (power_action is None and power_on):
            b6[0:2] = ['0', '1']
            b9_power_bit = '1'
        else:
            b6[0:2] = ['1', '0']
            b9_power_bit = '0'
        b6[4:6] = ['0', '0']

    # 风速设定 SS (bits 2:4)
    # 00 = Auto, 01 = Low, 11 = Medium, 10 = High
    fan_speed_lower = str(fan_speed).lower()
    if fan_speed_lower in ['medium', 'med']:
        b6[2:4] = ['1', '1']
    elif fan_speed_lower == 'low':
        b6[2:4] = ['0', '1']
    elif fan_speed_lower == 'high':
        b6[2:4] = ['1', '0']
    else:  # 'auto' or default
        b6[2:4] = ['0', '0']
        
    if mode == 'cooling':
        b6[6:8] = ['0', '1']
        mode_b7 = '0'
    elif mode == 'auto':
        b6[6:8] = ['0', '0']
        mode_b7 = '1'
    elif mode == 'heating':
        b6[6:8] = ['1', '0']
        mode_b7 = '0'
    elif mode == 'dehumidify':
        b6[6:8] = ['1', '1']
        mode_b7 = '0'
        
    base_bytes[5] = "".join(b6)
    base_bytes[8] = base_bytes[8][:5] + b9_power_bit + base_bytes[8][6:]
    
    # 摄氏度换算公式: Raw = (T_C - 4.0) / 0.5
    t_val = int(round((temp_c - 4.0) / 0.5))
    combo_flag = "1" if timer_mode == 'combo' else "0"
    base_bytes[6] = f"{t_val:06b}"[::-1] + combo_flag + mode_b7
    
    c_val = int(round((measured_temp_c - 4.0) / 0.5))
    base_bytes[7] = f"{c_val:06b}"[::-1] + base_bytes[7][6:]
    
    if timer_mode in ['off', 'combo']:
        val_off = (timer_off_hours << 3) | (timer_off_minutes // 10)
        base_bytes[9] = f"{val_off:08b}"[::-1]
    
    if timer_mode in ['on', 'combo']:
        val_on = (timer_on_hours << 3) | (timer_on_minutes // 10)
        base_bytes[10] = f"{val_on:08b}"[::-1]
        
    rtc_m_bits = f"{current_time_minutes:06b}"[::-1]
    rtc_h_bits = f"{current_time_hours:05b}"[::-1]
    base_bytes[11] = rtc_m_bits + rtc_h_bits[0:2]
    base_bytes[12] = rtc_h_bits[2:5] + base_bytes[12][3:]
        
    s_bit = '1' if quiet_mode else '0'
    base_bytes[15] = s_bit + base_bytes[15][1:]

    if power_action == 'cancel_timer':
        base_bytes[9] = "10010010"
        base_bytes[10] = "00001010"
        base_bytes[13] = "11100000"
    else:
        # 导风叶片/摆风设定 VVV (Byte 14, 前3位), 第4位为独立标志位(固定为 '1')
        # 3-bit VVV: 0 = Louver/Swing, 1 = Auto, 2..7 = Position 1 (底端) .. 6 (顶端)
        flap_str = str(flap).lower()
        if flap_str in ['swing', 'louver']:
            v_val = 0
        elif flap_str == 'auto':
            v_val = 1
        else:
            try:
                pos = int(flap)
                if 1 <= pos <= 6:
                    v_val = 1 + pos
                else:
                    v_val = 1
            except (ValueError, TypeError):
                v_val = 1
        # 格式化为 3 位并做 LSB 翻转，第 4 位保留独立标志位 '1'，后 4 位保持原有数据
        v_bits = f"{v_val:03b}"[::-1]
        base_bytes[13] = v_bits + '1' + base_bytes[13][4:]

    # Byte 15: N (bit 0: Night Setback), H (bit 3: High Power), I (bit 4: ION Mode)
    n_bit = '1' if night_setback else '0'
    h_bit = '1' if high_power else '0'
    i_bit = '1' if ion_mode else '0'
    base_bytes[14] = n_bit + base_bytes[14][1:3] + h_bit + i_bit + base_bytes[14][5:]
    
    # 1. 将字符串翻转，还原为单片机内存中真实的物理字节值
    actual_bytes = [int(b[::-1], 2) for b in base_bytes]
    
    # 2. 核心破解：4-bit Nibble 累加求和算法
    # 早期日系家电常用 4-bit 单片机，为防止内存溢出，校验码基于“半字节(Nibble)”进行累加
    nibble_sum = sum((b >> 4) + (b & 0x0F) for b in actual_bytes)
    
    # 3. 减去 8 的固定偏移量，并取低 8 位 (模拟 8-bit 寄存器溢出/下溢行为)
    checksum_val = (nibble_sum - 8) % 256
    
    # 4. 将计算出的真实校验码，再次翻转回 LSB 字符串格式，供物理层发射
    checksum_bin = f"{checksum_val:08b}"[::-1]
    
    return " ".join(base_bytes + [checksum_bin])


def binary_to_ir_ctl_format(binary_str):
    """
    将二进制字符串转换为 ir-ctl 兼容的纯文本脉冲/静默序列格式。
    """
    HEADER_PULSE = 3300
    HEADER_SPACE = 1725
    BIT_MARK = 440
    BIT_SPACE_0 = 405
    BIT_SPACE_1 = 1290
    TRAILER_PULSE = 440

    bits = binary_str.replace(" ", "")
    lines = []
    
    # 引导码
    lines.append(f"pulse {HEADER_PULSE}")
    lines.append(f"space {HEADER_SPACE}")
    
    # 数据位
    for bit in bits:
        lines.append(f"pulse {BIT_MARK}")
        if bit == '1':
            lines.append(f"space {BIT_SPACE_1}")
        else:
            lines.append(f"space {BIT_SPACE_0}")
            
    # 结束符与截断缓冲
    lines.append(f"pulse {TRAILER_PULSE}")
    lines.append(f"space 10000") 
    
    return "\n".join(lines)


LIRC_SET_SEND_CARRIER = 0x40046913
LIRC_SET_SEND_DUTY_CYCLE = 0x40046915

def binary_to_durations(binary_str):
    """
    将二进制字符串转换为微秒级持续时间序列 (整数数组)。
    """
    HEADER_PULSE = 3300
    HEADER_SPACE = 1725
    BIT_MARK = 440
    BIT_SPACE_0 = 405
    BIT_SPACE_1 = 1290
    TRAILER_PULSE = 440

    bits = binary_str.replace(" ", "")
    durations = [HEADER_PULSE, HEADER_SPACE]
    for bit in bits:
        durations.append(BIT_MARK)
        durations.append(BIT_SPACE_1 if bit == '1' else BIT_SPACE_0)
    durations.append(TRAILER_PULSE)
    return durations

def transmit_direct_lirc(binary_str, device="/dev/lirc0", carrier=38000, duty=50):
    """
    通过 Linux LIRC 原生内核字符设备接口直接发送红外信号（完全不依赖外部 ir-ctl 命令行工具与子进程）。
    """
    durations = binary_to_durations(binary_str)
    payload = struct.pack(f"<{len(durations)}I", *durations)
    
    print(f"🚀 正在直接写入原生内核设备 ({device}) 发射 (Carrier: {carrier}Hz, Duty: {duty}%, {len(durations)} 脉冲/静默)...")
    
    fd = os.open(device, os.O_RDWR)
    try:
        fcntl.ioctl(fd, LIRC_SET_SEND_CARRIER, struct.pack("I", carrier))
        fcntl.ioctl(fd, LIRC_SET_SEND_DUTY_CYCLE, struct.pack("I", duty))
        bytes_written = os.write(fd, payload)
        print(f"✅ 原生内核发射完成！直接写入 {bytes_written} 字节 (耗时 < 1ms，无外部子进程)。")
    except OSError as e:
        print(f"❌ 原生内核发射失败: {e}")
    finally:
        os.close(fd)


if __name__ == "__main__":
    import datetime
    
    # 动态获取当前系统的本地时间，并感知系统时区 (如当前的加州 Sunnyvale PDT 时间)
    now = datetime.datetime.now().astimezone()
    
    print("========================================")
    print("   AEHA 终极红外协议发射系统 (内核版)")
    print("========================================\n")
    
    print(f"1. 正在组合底层二进制指令 (取消定时 / Cancel Timer, 制冷模式, 当前时钟同步 {now.strftime('%H:%M %Z')})...")
    ac_code = generate_ac_code_lsb(
        power_on=False, 
        power_action='cancel_timer',
        temp_c=24.0, 
        measured_temp_c=27.0, 
        mode='cooling',
        fan_speed='auto',
        quiet_mode=True,
        current_time_hours=now.hour,
        current_time_minutes=now.minute
    )
    print(f"二进制负载: {ac_code}\n")
    
    print("2. 启动硬件调用进程 (原生内核模式)...")
    transmit_direct_lirc(ac_code, device="/dev/lirc0", carrier=38000, duty=50)
