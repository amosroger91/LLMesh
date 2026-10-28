import { Contract, JsonRpcProvider, Wallet, AbiCoder, getBytes, keccak256, randomBytes, formatEther, isAddress, FetchRequest, parseEther, MaxUint256, verifyMessage } from 'ethers';
const TOKEN_ABI = ['function balanceOf(address) view returns(uint256)', 'function registered(address) view returns(bool)',
  'function issuer() view returns(address)', 'function register(address,bytes32,uint256,bytes)', 'function approve(address,uint256) returns(bool)', 'function allowance(address,address) view returns(uint256)'];
const ESCROW_ABI = ['function token() view returns(address)', 'function coordinator() view returns(address)',
  'function version() view returns(uint256)', 'function PRICE() view returns(uint256)', 'function jobs(bytes32) view returns(address payer,address worker,bytes32 nostr,uint64 expires,uint8 state,uint256 amount,uint8 level)',
  'function lock(bytes32,bytes32,address,uint8)', 'function claimDelivered(bytes32,bytes32,bytes)', 'function refundFailed(bytes32,bytes)', 'function settle(bytes32)', 'function refund(bytes32)'];
export class Payments {
  constructor(privateKey, settings = {}) { this.wallet = new Wallet(privateKey); this.settings = settings; this.state = { configured: false, address: this.wallet.address, symbol: 'LLMESH' }; }
  mutate(fn) {
    const next = (this.transactions ?? Promise.resolve()).catch(() => {}).then(fn);
    this.transactions = next; return next;
  }
  submit(send) {
    return this.mutate(async () => {
      this.nextNonce ??= await this.provider.getTransactionCount(this.wallet.address, 'pending');
      try { const tx = await send({ nonce: this.nextNonce }); this.nextNonce++; return tx; }
      catch (error) { this.nextNonce = undefined; throw error; }
    });
  }
  async approveIfNeeded(price) {
    if (this.approving) return this.approving;
    this.approving = (async () => {
      if (await this.token.allowance(this.wallet.address, this.settings.escrow) >= price) return;
      const tx = await this.submit(overrides => this.token.approve(this.settings.escrow, MaxUint256, overrides));
      await tx.wait(1, 120000);
    })();
    try { await this.approving; } finally { this.approving = null; }
  }
  async startConnection(delay = 1000) {
    clearTimeout(this.reconnectTimer);
    try { await this.connect(); this.state.error = null; }
    catch (error) {
      this.state.configured = false; this.state.error = error.message;
      if (!this.closed) { this.reconnectTimer = setTimeout(() => { void this.startConnection(Math.min(delay * 2, 60000)); }, delay); this.reconnectTimer.unref(); }
    }
  }
  async connect(settings = this.settings) {
    if (!settings.rpc || !settings.token || !settings.escrow) return this.status();
    const url = new URL(settings.rpc);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS RPC or a local development RPC');
    if (!isAddress(settings.token) || !isAddress(settings.escrow) || ![31337, 84532, 8453].includes(Number(settings.chainId))) throw new Error('Use Base, Base Sepolia, or local test chain and valid contracts');
    const request = new FetchRequest(settings.rpc); request.timeout = 10000;
    const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: 0 });
    try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(settings.chainId)) { provider.destroy(); throw new Error('RPC chain ID mismatch'); }
    const signer = this.wallet.connect(provider), token = new Contract(settings.token, TOKEN_ABI, signer), escrow = new Contract(settings.escrow, ESCROW_ABI, signer);
    const [tokenAddress, coordinator, issuer] = await Promise.all([escrow.token(), escrow.coordinator(), token.issuer()]);
    if (await escrow.version() !== 3n) throw new Error('Fixed request quotes require escrow version 3; deploy the updated contract');
    if (tokenAddress.toLowerCase() !== settings.token.toLowerCase() || coordinator.toLowerCase() !== issuer.toLowerCase()) { provider.destroy(); throw new Error('Token/escrow issuer mismatch'); }
    this.provider?.destroy(); this.nextNonce = undefined; Object.assign(this, { provider, signer, token, escrow, settings, coordinator });
    this.state = { ...this.state, configured: true, chainId: Number(network.chainId), coordinator, isCoordinator: coordinator.toLowerCase() === this.wallet.address.toLowerCase(), token: settings.token, escrow: settings.escrow };
    return this.refresh();
    } catch (error) { provider.destroy(); if (this.provider === provider) this.state.configured = false; throw error; }
  }
  status() { return { ...this.state, settings: this.settings, jobs: this.history?.() ?? [] }; }
  async refresh() {
    if (!this.provider) return this.status();
    const [balance, native, registered] = await Promise.all([this.token.balanceOf(this.wallet.address), this.provider.getBalance(this.wallet.address), this.token.registered(this.wallet.address)]);
    Object.assign(this.state, { balance: formatEther(balance), nativeBalance: formatEther(native), registered }); return this.status();
  }
  async account(wallet) {
    if (!this.token || !isAddress(wallet)) throw new Error('Registered wallet required');
    return { wallet, balance: formatEther(await this.token.balanceOf(wallet)), registered: await this.token.registered(wallet),
      chainId: this.state.chainId, token: this.settings.token, escrow: this.settings.escrow };
  }
  async voucher(nostr, wallet) {
    if (!this.state.isCoordinator) throw new Error('Request a starter grant from the configured coordinator');
    if (!/^[a-f0-9]{64}$/.test(nostr) || !isAddress(wallet)) throw new Error('Invalid account identity');
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'address', 'bytes32', 'uint256'],
      [this.state.chainId, this.settings.token, wallet, '0x' + nostr, deadline]));
    return { nostr: '0x' + nostr, wallet, deadline, signature: await this.wallet.signMessage(getBytes(digest)) };
  }
  async register(nostr, getVoucher) {
    if (!this.state.configured) throw new Error('Configure deployed token and escrow first');
    if (await this.token.registered(this.wallet.address)) return this.refresh();
    const voucher = this.state.isCoordinator ? await this.voucher(nostr, this.wallet.address) : await getVoucher?.();
    if (await this.token.registered(this.wallet.address)) return this.refresh();
    if (!voucher || voucher.nostr !== '0x' + nostr || voucher.wallet?.toLowerCase() !== this.wallet.address.toLowerCase()) throw new Error('Invalid coordinator grant voucher');
    const tx = await this.submit(overrides => this.token.register(voucher.wallet, voucher.nostr, voucher.deadline, voucher.signature, overrides));
    await tx.wait(1, 120000); return this.refresh();
  }
  async begin(nostr, worker, payment, localIdentity, priceUnits = 1) {
    if (![1, 2, 3].includes(priceUnits)) throw new Error('Invalid request quote');
    if (!this.state.configured || !this.state.isCoordinator) throw new Error('A funded Base token escrow and its coordinator wallet must be configured before inference');
    if (!isAddress(worker)) throw new Error('Worker has no receiving wallet');
    let id = payment?.id;
    if (!id) {
      if (nostr !== localIdentity) throw new Error('Supply a funded escrow payment.id bound to your Nostr key and selected worker');
      const clientId = keccak256(randomBytes(32));
      const jobId = keccak256(AbiCoder.defaultAbiCoder().encode(['address','bytes32'], [this.wallet.address, clientId])), price = parseEther(String(priceUnits));
      this.record?.({ id: jobId, worker, state: 'funding', transaction: null });
      await this.approveIfNeeded(price);
      const tx = await this.submit(overrides => this.escrow.lock(clientId, '0x' + nostr, worker, priceUnits - 1, overrides));
      this.record?.({ id: jobId, worker, state: 'confirming', transaction: tx.hash });
      await tx.wait(1, 120000); id = jobId;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error('Invalid escrow job ID');
    await this.verify(id, nostr, worker, priceUnits);
    this.record?.({ id, worker, state: 'funded', transaction: null });
    return { id, worker, priceUnits, chainId: this.state.chainId, escrow: this.settings.escrow };
  }
  async verify(id, nostr, worker, priceUnits = 1) {
    if (!this.escrow) throw new Error('Worker payment network is not configured');
    const job = await this.escrow.jobs(id);
    if (job.state !== 1n || job.nostr.toLowerCase() !== ('0x' + nostr).toLowerCase() || job.worker.toLowerCase() !== worker.toLowerCase() ||
        job.amount !== parseEther(String(priceUnits)) || Number(job.level) !== priceUnits - 1 ||
        Number(job.expires) * 1000 < Date.now() + 180000) throw new Error('Escrow is unfunded, expired, reused, underpriced, or bound to a different identity/worker');
    return job;
  }
  async relayVoucher(voucher) {
    if (!this.state.isCoordinator) throw new Error('Only the grant coordinator can sponsor registration gas');
    if (await this.token.registered(voucher.wallet)) return { ...voucher, registered: true };
    const tx = await this.submit(overrides => this.token.register(voucher.wallet, voucher.nostr, voucher.deadline, voucher.signature, overrides));
    const receipt = await tx.wait(1, 120000); return { ...voucher, registered: true, transaction: receipt.hash };
  }
  deliveryDigest(payment, outputHash) {
    return keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','bytes32','bytes32'], [this.state.chainId, this.settings.escrow, payment.id, outputHash]));
  }
  async signDelivery(payment, outputHash) {
    if (!this.state.isCoordinator) throw new Error('Only coordinator can acknowledge delivery');
    return this.wallet.signMessage(getBytes(this.deliveryDigest(payment, outputHash)));
  }
  async acceptDelivery(payment) {
    if (payment.chainId !== this.state.chainId || payment.escrow?.toLowerCase() !== this.settings.escrow?.toLowerCase() ||
        verifyMessage(getBytes(this.deliveryDigest(payment, payment.outputHash)), payment.attestation).toLowerCase() !== this.coordinator.toLowerCase()) throw new Error('Invalid delivery attestation');
    const job = await this.escrow.jobs(payment.id);
    if (job.worker.toLowerCase() !== this.wallet.address.toLowerCase()) throw new Error('Delivery is for another worker');
  }
  async signRefund(payment) {
    const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','bytes32','string'], [this.state.chainId, this.settings.escrow, payment.id, 'refund-failed']));
    return this.wallet.signMessage(getBytes(digest));
  }
  async settle(payment) {
    const job = await this.escrow.jobs(payment.id);
    const previous = this.lookup?.(payment.id) ?? this.history?.().find(row => row.id === payment.id);
    if (job.state === 2n) {
      if (!previous?.settlement_tx) return null;
      const confirmed = await this.provider.getTransactionReceipt(previous.settlement_tx);
      return confirmed?.status === 1 ? confirmed.hash : null;
    }
    if (job.state !== 1n) throw new Error('Settlement conflict: escrow is not funded');
    let tx;
    if (previous?.settlement_tx) {
      const confirmed = await this.provider.getTransactionReceipt(previous.settlement_tx);
      if (!confirmed || confirmed.status === 1) tx = await this.provider.getTransaction(previous.settlement_tx);
    }
    if (!tx) {
      tx = await this.submit(overrides => payment.attestation
        ? this.escrow.claimDelivered(payment.id, payment.outputHash, payment.attestation, overrides)
        : this.escrow.settle(payment.id, overrides));
      this.record?.({ ...payment, state: 'settle-broadcast', transaction: tx.hash });
    }
    const receipt = await tx.wait(1, 120000);
    this.record?.({ ...payment, state: 'settled', transaction: receipt.hash });
    await this.refresh().catch(error => { this.state.error = error.message; }); return receipt.hash;
  }
  async refund(payment) {
    const recorded = this.lookup?.(payment.id);
    if (recorded && ['settle-pending', 'settle-broadcast', 'settled'].includes(recorded.state)) throw new Error('Delivered requests cannot be refunded; settlement is pending or complete');
    const job = await this.escrow.jobs(payment.id);
    if (job.state === 3n) return null;
    if (job.state !== 1n) throw new Error('Cannot refund a completed or unknown escrow');
    const tx = await this.submit(overrides => payment.refundAuthorization ? this.escrow.refundFailed(payment.id, payment.refundAuthorization, overrides) : this.escrow.refund(payment.id, overrides));
    const receipt = await tx.wait(1, 120000);
    this.record?.({ ...payment, state: 'refunded', transaction: receipt.hash });
    await this.refresh().catch(error => { this.state.error = error.message; }); return receipt.hash;
  }
  close() { this.closed = true; clearTimeout(this.reconnectTimer); this.provider?.destroy(); }
}
