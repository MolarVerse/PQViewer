# Remote access

Run PQViewer on the server holding your trajectory and use SSH forwarding to
open it in your desktop browser. Keep the default `127.0.0.1` binding.
[Install PQViewer](getting-started.md#install) in the server's Python environment.

## From home or over a VPN

Connect to your institutional VPN first when it is required to reach the
server. On your desktop, confirm that SSH access works:

```bash
ssh user@server
```

In that server terminal, start the viewer:

```bash
pqviewer /path/to/trajectory.xyz --no-open --port 8765
```

In a second terminal on your desktop, start the tunnel:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8765:127.0.0.1:8765 user@server
```

Open `http://127.0.0.1:8765` in your desktop browser. Replace `user@server` and
the trajectory path with your own account, hostname, and server path. The same
tunnel works on the institution's network when SSH access is available.

Keep PQViewer and the SSH tunnel running. The tunnel terminal normally stays
quiet; stop it with `Ctrl+C` when finished. `ExitOnForwardFailure` reports a
local bind failure; it does not check whether PQViewer is running remotely.

## A compute node behind a login node

If your site's SSH policy permits access to an allocated compute node through
the login node, start PQViewer **on the compute node** inside your allocation.
On your desktop, use the login node as a jump host:

```bash
ssh -N -o ExitOnForwardFailure=yes -J user@login.cluster \
  -L 127.0.0.1:8765:127.0.0.1:8765 user@compute-node
```

The destination is the node running PQViewer. Use its actual allocated
hostname and keep the allocation, viewer, and tunnel alive. If compute-node
SSH is restricted, follow your site's supported forwarding method.

## A different desktop port

If desktop port 8765 is busy, forward port 18765 to the server's port 8765:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18765:127.0.0.1:8765 user@server
```

Open `http://127.0.0.1:18765`. The server command remains on port 8765.

## Where data goes

Source files are read on the server, and PQAnalysis calculations run there.
The browser interface, selected frame coordinates, and chart data are sent to
your desktop through the encrypted SSH connection; the browser renders them.
Files chosen with **Open** or drag-and-drop come from your desktop and are
uploaded to the server. Frame, figure, and chart downloads are saved on your
desktop.

## Troubleshooting

- **SSH cannot connect:** confirm that the VPN is connected and that the
  server's hostname resolves and has a VPN route. Check `ssh user@server`
  before opening the tunnel; use the institution's SSH hostname and account.
- **The local port is busy:** use the alternate local port above, or stop the
  existing tunnel that owns it.
- **SSH connects but the page does not:** confirm that PQViewer is still
  running on the SSH destination and that its port matches the tunnel's remote
  port. For a compute node, check that the allocation is still active.
- **The VPN drops:** reconnect it and start the tunnel again. Confirm that the
  server process and allocation are still running.

PQViewer has no HTTP authentication. SSH forwarding provides authenticated,
encrypted access while the app remains on loopback; changing `--host` is not
needed for this workflow.
