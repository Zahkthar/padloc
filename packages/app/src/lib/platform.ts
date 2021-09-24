import { Platform, StubPlatform, DeviceInfo } from "@padloc/core/src/platform";
import { bytesToBase64 } from "@padloc/core/src/encoding";
import { WebCryptoProvider } from "./crypto";
import { LocalStorage } from "./storage";
import { AuthPurpose, AuthType } from "@padloc/core/src/mfa";
import { webAuthnClient } from "./mfa/webauthn";
import {
    StartRegisterAuthenticatorResponse,
    CompleteRegisterMFAuthenticatorParams,
    StartAuthRequestParams,
    CompleteAuthRequestParams,
    StartRegisterAuthenticatorParams,
    StartAuthRequestResponse,
} from "@padloc/core/src/api";
import { prompt } from "./dialog";
import { app } from "../globals";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { translate as $l } from "@padloc/locale/src/translate";
import { generateURL } from "@padloc/core/src/otp";
import { html } from "lit";
import "../elements/qr-code";
import { OpenIDClient } from "./mfa/openid";

const browserInfo = (async () => {
    const { default: UAParser } = await import(/* webpackChunkName: "ua-parser" */ "ua-parser-js");
    return new UAParser(navigator.userAgent).getResult();
})();

export class WebPlatform extends StubPlatform implements Platform {
    private _clipboardTextArea: HTMLTextAreaElement;
    private _qrVideo: HTMLVideoElement;
    private _qrCanvas: HTMLCanvasElement;

    crypto = new WebCryptoProvider();
    storage = new LocalStorage();

    // Set clipboard text using `document.execCommand("cut")`.
    // NOTE: This only works in certain environments like Google Chrome apps with the appropriate permissions set
    async setClipboard(text: string): Promise<void> {
        this._clipboardTextArea = this._clipboardTextArea || document.createElement("textarea");
        this._clipboardTextArea.contentEditable = "true";
        this._clipboardTextArea.readOnly = false;
        this._clipboardTextArea.value = text;
        document.body.appendChild(this._clipboardTextArea);
        const range = document.createRange();
        range.selectNodeContents(this._clipboardTextArea);

        const s = window.getSelection();
        s!.removeAllRanges();
        s!.addRange(range);
        this._clipboardTextArea.select();

        this._clipboardTextArea.setSelectionRange(0, this._clipboardTextArea.value.length);

        document.execCommand("cut");
        document.body.removeChild(this._clipboardTextArea);
    }

    // Get clipboard text using `document.execCommand("paste")`
    // NOTE: This only works in certain environments like Google Chrome apps with the appropriate permissions set
    async getClipboard(): Promise<string> {
        this._clipboardTextArea = this._clipboardTextArea || document.createElement("textarea");
        document.body.appendChild(this._clipboardTextArea);
        this._clipboardTextArea.value = "";
        this._clipboardTextArea.select();
        document.execCommand("paste");
        document.body.removeChild(this._clipboardTextArea);
        return this._clipboardTextArea.value;
    }

    async getDeviceInfo() {
        const { os, browser } = await browserInfo;
        const platform = (os.name && os.name.replace(" ", "")) || "";
        return new DeviceInfo({
            platform,
            osVersion: (os.version && os.version.replace(" ", "")) || "",
            id: "",
            appVersion: process.env.PL_VERSION || "",
            manufacturer: "",
            model: "",
            browser: browser.name || "",
            userAgent: navigator.userAgent,
            locale: navigator.language || "en",
            description: browser.name ? $l("{0} on {1}", browser.name, platform) : $l("{0} Device", platform),
        });
    }

    async scanQR() {
        return new Promise<string>((resolve, reject) => {
            const tick = async () => {
                if (this._qrVideo.readyState !== this._qrVideo.HAVE_ENOUGH_DATA) {
                    requestAnimationFrame(() => tick());
                    return;
                }

                const { default: jsQR } = await import(/* webpackChunkName: "jsqr" */ "jsqr");

                const canvas = this._qrCanvas.getContext("2d")!;
                this._qrCanvas.height = this._qrVideo.videoHeight;
                this._qrCanvas.width = this._qrVideo.videoWidth;
                canvas.drawImage(this._qrVideo, 0, 0, this._qrCanvas.width, this._qrCanvas.height);
                const imageData = canvas.getImageData(0, 0, this._qrCanvas.width, this._qrCanvas.height);
                const code = jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: "dontInvert",
                });
                if (code) {
                    resolve(code.data);
                }
                requestAnimationFrame(() => tick());
            };

            if (!this._qrVideo) {
                this._qrVideo = document.createElement("video");
                this._qrVideo.setAttribute("playsinline", "");
                this._qrVideo.setAttribute("muted", "");
                this._qrVideo.setAttribute("autoplay", "");
            }

            if (!this._qrCanvas) {
                this._qrCanvas = document.createElement("canvas");
                Object.assign(this._qrCanvas.style, {
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    zIndex: "-1",
                });
                document.body.appendChild(this._qrCanvas);
            }

            this._qrCanvas.style.display = "block";

            navigator.mediaDevices
                .getUserMedia({ audio: false, video: { facingMode: "environment" } })
                .then((stream) => {
                    // Use facingMode: environment to attemt to get the front camera on phones
                    this._qrVideo.srcObject = stream;
                    this._qrVideo.play();
                    requestAnimationFrame(() => tick());
                }, reject);
        });
    }

    async stopScanQR() {
        const stream: MediaStream | null = this._qrVideo && (this._qrVideo.srcObject as MediaStream);
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }

        this._qrVideo && (this._qrVideo.srcObject = null);
        this._qrCanvas.style.display = "none";
    }

    async composeEmail(addr: string, subj: string, msg: string) {
        window.open(`mailto:${addr}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(msg)}`, "_system");
    }

    async saveFile(name: string, type: string, contents: Uint8Array) {
        const a = document.createElement("a");
        a.href = `data:${type};base64,${bytesToBase64(contents, false)}`;
        a.download = name;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    supportsAuthType(type: AuthType) {
        const types = [
            AuthType.Email,
            AuthType.Totp,
            ...[AuthType.WebAuthnPlatform, AuthType.WebAuthnPortable].filter((t) => webAuthnClient.supportsType(t)),
        ];

        return types.includes(type);
    }

    protected async _prepareRegisterMFAuthenticator({ data, type }: StartRegisterAuthenticatorResponse): Promise<any> {
        switch (type) {
            case AuthType.WebAuthnPlatform:
            case AuthType.WebAuthnPortable:
                return webAuthnClient.prepareRegistration(data, undefined);
            case AuthType.Email:
                const code = await prompt(
                    $l("Please enter the confirmation code sent to your email address to proceed!"),
                    {
                        title: $l("Add MFA-Method"),
                        placeholder: $l("Enter Verification Code"),
                        confirmLabel: $l("Submit"),
                        type: "number",
                        pattern: "[0-9]*",
                    }
                );
                return code ? { code } : null;
            case AuthType.Totp:
                const secret = data.secret as string;
                const url = generateURL({
                    secret,
                    account: app.account?.email || "",
                });
                const code2 = await prompt(
                    html`
                        <div class="bottom-margined">
                            ${$l(
                                "Please scan the following qr-code in your authenticator app, then enter the displayed code to confirm!"
                            )}
                        </div>
                        <div class="centering vertical layout">
                            <pl-qr-code .value=${url} class="huge"></pl-qr-code>
                            <div class="tiny subtle top-margined"><strong>Secret:</strong> ${secret}</div>
                        </div>
                    `,
                    {
                        title: $l("Add MFA-Method"),
                        placeholder: $l("Enter Verification Code"),
                        confirmLabel: $l("Submit"),
                        type: "number",
                        pattern: "[0-9]*",
                    }
                );
                return code2 ? { code: code2 } : null;
            case AuthType.OpenID:
                const client = new OpenIDClient();
                const res = await client.prepareRegistration(data, undefined);
                console.log("data", res);
                return res;
            default:
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, $l("Authentication type not supported!"));
        }
    }

    async registerAuthenticator({
        purposes,
        type,
        data,
        device,
    }: {
        purposes: AuthPurpose[];
        type: AuthType;
        data?: any;
        device?: DeviceInfo;
    }) {
        const res = await app.api.startRegisterAuthenticator(
            new StartRegisterAuthenticatorParams({ purposes, type, data, device })
        );
        try {
            const prepData = await this._prepareRegisterMFAuthenticator(res);
            if (!prepData) {
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, $l("Setup Canceled"));
            }
            await app.api.completeRegisterAuthenticator(
                new CompleteRegisterMFAuthenticatorParams({ id: res.id, data: prepData })
            );
            return res.id;
        } catch (e) {
            await app.api.deleteAuthenticator(res.id);
            throw e;
        }
    }

    protected async _prepareCompleteAuthRequest({ data, type }: StartAuthRequestResponse): Promise<any> {
        switch (type) {
            case AuthType.WebAuthnPlatform:
            case AuthType.WebAuthnPortable:
                return webAuthnClient.prepareAuthentication(data, undefined);
            case AuthType.Email:
                const code = await prompt(
                    $l("Please enter the confirmation code sent to your email address to proceed!"),
                    {
                        title: $l("Email Authentication"),
                        placeholder: $l("Enter Verification Code"),
                        confirmLabel: $l("Submit"),
                        type: "number",
                        pattern: "[0-9]*",
                    }
                );
                return code ? { code } : null;
            case AuthType.Totp:
                const code2 = await prompt(
                    $l("Please enter the code displayed in your authenticator app to proceed!"),
                    {
                        title: $l("TOTP Authentication"),
                        placeholder: $l("Enter Verification Code"),
                        confirmLabel: $l("Submit"),
                        type: "number",
                        pattern: "[0-9]*",
                    }
                );
                return code2 ? { code: code2 } : null;
            case AuthType.OpenID:
                const client = new OpenIDClient();
                const res = await client.prepareAuthentication(data, undefined);
                console.log("data", res);
                return res;
            default:
                throw new Err(ErrorCode.AUTHENTICATION_FAILED, $l("Authentication type not supported!"));
        }
    }

    async getAuthToken({
        purpose,
        type,
        email = app.account?.email,
        authenticatorId,
        authenticatorIndex,
    }: {
        purpose: AuthPurpose;
        type?: AuthType;
        email?: string;
        authenticatorId?: string;
        authenticatorIndex?: number;
    }) {
        const res = await app.api.startAuthRequest(
            new StartAuthRequestParams({ email, type, purpose, authenticatorId, authenticatorIndex })
        );

        const data = await this._prepareCompleteAuthRequest(res);

        if (!data) {
            throw new Err(ErrorCode.AUTHENTICATION_FAILED, $l("Request was canceled."));
        }

        await app.api.completeAuthRequest(new CompleteAuthRequestParams({ id: res.id, data, email }));

        return res.token;
    }

    readonly platformAuthType: AuthType | null = AuthType.WebAuthnPlatform;

    async supportsPlatformAuthenticator() {
        return this.supportsAuthType(AuthType.WebAuthnPlatform);
    }

    async registerPlatformAuthenticator(purposes: AuthPurpose[]) {
        if (!this.platformAuthType) {
            throw new Err(ErrorCode.NOT_SUPPORTED);
        }
        return this.registerAuthenticator({
            purposes,
            type: this.platformAuthType,
            device: app.state.device,
        });
    }
}
