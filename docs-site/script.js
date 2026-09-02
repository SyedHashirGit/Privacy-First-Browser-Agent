function copyCode(elementId) {
    const codeElement = document.getElementById(elementId);
    const textToCopy = codeElement.innerText;
    
    navigator.clipboard.writeText(textToCopy).then(() => {
        const btn = codeElement.previousElementSibling;
        const originalText = btn.innerText;
        btn.innerText = "BAM! Copied!";
        btn.style.backgroundColor = "#00e5ff";
        btn.style.color = "#000";
        
        setTimeout(() => {
            btn.innerText = originalText;
            btn.style.backgroundColor = "var(--magenta)";
            btn.style.color = "white";
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy text: ', err);
    });
}
