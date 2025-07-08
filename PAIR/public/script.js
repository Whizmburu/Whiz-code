document.addEventListener('DOMContentLoaded', () => {
    const getPairingCodeBtn = document.getElementById('get-pairing-code-btn');
    const nextNumberBtn = document.getElementById('next-number-btn');
    const phoneNumberInput = document.getElementById('phone-number');
    const pairingCodeDisplay = document.getElementById('pairing-code');
    const statusMessageDisplay = document.getElementById('status-message');
    const sessionStatusMessageDisplay = document.getElementById('session-status-message');

    let currentPairingPhoneNumber = null;

    getPairingCodeBtn.addEventListener('click', async () => {
        const phoneNumber = phoneNumberInput.value.trim();
        if (!phoneNumber) {
            statusMessageDisplay.textContent = 'Please enter a phone number.';
            statusMessageDisplay.className = 'status-message error';
            return;
        }

        currentPairingPhoneNumber = phoneNumber;
        pairingCodeDisplay.textContent = '';
        sessionStatusMessageDisplay.textContent = '';
        statusMessageDisplay.textContent = 'Requesting pairing code...';
        statusMessageDisplay.className = 'status-message info';
        getPairingCodeBtn.disabled = true;
        nextNumberBtn.disabled = true;

        try {
            const response = await fetch('/pair', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ phoneNumber }),
            });

            const data = await response.json();

            if (response.ok && data.pairingCode) {
                pairingCodeDisplay.textContent = data.pairingCode;
                statusMessageDisplay.textContent = 'Pairing code received. Enter it on your WhatsApp linked devices screen. Waiting for you to confirm...';
                statusMessageDisplay.className = 'status-message info';
                // After code is displayed, wait for user to confirm pairing and then trigger session info send
                // This could be a manual button, or a timeout, or ideally a websocket message from server.
                // For simplicity, we'll assume the user pairs and then we can try to send session info.
                // A more robust solution would involve websockets for real-time status updates.
                setTimeout(triggerSessionInfoSend, 15000); // Wait 15s then try to send session info
            } else {
                pairingCodeDisplay.textContent = '---';
                statusMessageDisplay.textContent = data.error || 'Failed to get pairing code.';
                statusMessageDisplay.className = 'status-message error';
            }
        } catch (error) {
            console.error('Error fetching pairing code:', error);
            pairingCodeDisplay.textContent = '---';
            statusMessageDisplay.textContent = 'Error requesting pairing code. Check console.';
            statusMessageDisplay.className = 'status-message error';
        } finally {
            getPairingCodeBtn.disabled = false;
            nextNumberBtn.disabled = false;
        }
    });

    async function triggerSessionInfoSend() {
        if (!currentPairingPhoneNumber) {
            // This might happen if timeout fires after "Next Number" was clicked
            return;
        }
        statusMessageDisplay.textContent = 'Attempting to finalize session and send info...';
        statusMessageDisplay.className = 'status-message info';
        try {
            const response = await fetch('/session-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: currentPairingPhoneNumber }) // Send phone number for context on backend
            });
            const data = await response.json();
            if (response.ok && data.message) {
                sessionStatusMessageDisplay.textContent = data.message; // "Session ID and success message sent."
                statusMessageDisplay.textContent = 'Pairing process complete for this number!';
                statusMessageDisplay.className = 'status-message success';
            } else {
                statusMessageDisplay.textContent = data.error || 'Failed to send session info.';
                statusMessageDisplay.className = 'status-message error';
            }
        } catch (error) {
            console.error('Error triggering session info:', error);
            statusMessageDisplay.textContent = 'Error finalizing session. Check console.';
            statusMessageDisplay.className = 'status-message error';
        }
        currentPairingPhoneNumber = null; // Reset for next attempt
    }

    nextNumberBtn.addEventListener('click', () => {
        phoneNumberInput.value = '';
        pairingCodeDisplay.textContent = '';
        statusMessageDisplay.textContent = '';
        sessionStatusMessageDisplay.textContent = '';
        statusMessageDisplay.className = 'status-message';
        currentPairingPhoneNumber = null;
        // Optionally, send a /reset-pairing request to the backend if needed
        // For now, we assume backend handles reset on new /pair request
        console.log("UI reset for next number.");
    });
});
