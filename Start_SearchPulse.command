#!/bin/bash

# Navigate to the directory where this script is located
cd "$(dirname "$0")"

echo "Starting SearchPulse..."
echo "This will open your default browser automatically."

# Start the dev server
npm run dev
