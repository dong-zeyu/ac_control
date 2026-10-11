#!/usr/bin/env bash
# ==============================================================================
# Live IR Capture & AC Decode Pipeline
# Captures infrared signals on the fly and pipes them directly to stdout / decoder
# ==============================================================================

DEVICE="/dev/lirc1"
MODE="card" # card, compact, raw, json

# Parse optional command line flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--device)
            DEVICE="$2"
            shift 2
            ;;
        -c|--compact)
            MODE="compact"
            shift
            ;;
        -r|--raw)
            MODE="raw"
            shift
            ;;
        -j|--json)
            MODE="json"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  -c, --compact    Show compact 1-line decoded output on the fly"
            echo "  -r, --raw        Output raw 19-byte binary on the fly"
            echo "  -j, --json       Output JSON stream on the fly"
            echo "  -d, --device DEV Set input device (default: /dev/lirc1)"
            echo "  -h, --help       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📡 Starting live IR stream from $DEVICE (Mode: $MODE)..."
echo "👉 Point remote and press buttons (Press Ctrl+C to stop)"
echo ""

# The AWK stage: Converts mode2 pulse/space timings into clean 19-byte binary lines.
# Flushes \n immediately upon receiving the 152nd bit so the pipeline never hangs.
AWK_STREAM='
BEGIN { bits=0; is_header=0 }
/^pulse/ {
    if ($2 > 3000) {
        bits = 0
        is_header = 1
    }
}
/^space/ {
    if (is_header) {
        is_header = 0
    } else if ($2 < 5000 && bits < 152) {
        printf "%s", ($2 > 1000 ? "1" : "0")
        bits++
        if (bits % 8 == 0) {
            if (bits == 152) {
                printf "\n"
            } else {
                printf " "
            }
        }
        fflush()
    }
}
'

if [ "$MODE" = "raw" ]; then
    mode2 -d "$DEVICE" | awk "$AWK_STREAM"
elif [ "$MODE" = "compact" ]; then
    mode2 -d "$DEVICE" | awk "$AWK_STREAM" | python3 -u "$SCRIPT_DIR/decode_ac.py" --compact
elif [ "$MODE" = "json" ]; then
    mode2 -d "$DEVICE" | awk "$AWK_STREAM" | python3 -u "$SCRIPT_DIR/decode_ac.py" --json
else
    # Default: card mode
    mode2 -d "$DEVICE" | awk "$AWK_STREAM" | python3 -u "$SCRIPT_DIR/decode_ac.py"
fi
