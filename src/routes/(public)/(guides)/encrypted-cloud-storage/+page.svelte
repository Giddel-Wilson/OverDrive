<h1>How encrypted cloud storage works in OverDrive</h1>
<p>
	When you drop a photo into your vault, your browser encrypts the original, its filename and
	any thumbnail it creates. Open the vault on another device and your browser there decrypts
	them so you can find the photo by name or browse it in Photos.
</p>

<h2>What happens before a file leaves your browser?</h2>
<p>
	OverDrive gives each file a fresh encryption key. Your browser uses AES-256-GCM or
	ChaCha20-Poly1305 to encrypt the file in chunks. It then wraps the file key using your
	vault’s public key. Wrapping is a way to store an encrypted copy of a key alongside the data
	it unlocks.
</p>
<p>
	If an upload stops midway, open <strong>Incomplete uploads</strong>, choose
	<strong>Resume</strong> and select the same file again. OverDrive skips the chunks already
	in storage.
</p>

<h2>What can the server see?</h2>
<p>
	The server stores encrypted file contents, filenames and file types. It also keeps the
	account email, the amount of storage used and the timestamps it needs to manage uploads.
	For example, it can count the bytes a photo takes up while its name and image stay encrypted.
</p>

<h2>How do I open my files on another device?</h2>
<p>
	Sign in to OverDrive in the new browser. Your password unlocks your vault’s private key
	locally. When you download a file, the browser unwraps that file’s key, checks the stored
	ciphertext for changes and decrypts the contents.
</p>
<p>
	If you forget your password, choose <strong>Forgot password</strong> on the sign-in page and
	enter your email, recovery key and a new password. Keep a copy of your recovery kit outside
	the vault so you can reach it when you’re signed out.
</p>
<p>
	To give another person access to a single file, follow the
	<a href="/password-protected-file-sharing">guide to password-protected file sharing</a>.
</p>
