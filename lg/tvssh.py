"""Small helper to talk to the LG TV in Developer Mode over SSH (port 9922, user prisoner).
Key: lg/.devkey/webos_rsa (fetched from the TV key server http://<tv>:9991/webos_rsa, git-ignored).
Passphrase: env TV_PASSPHRASE (shown on the TV's Developer Mode screen). Never printed.
  python lg/tvssh.py run "<cmd>"
  python lg/tvssh.py install <file.ipk>
  python lg/tvssh.py launch <appId> ['{"params":...}']
"""
import os, sys, json, time, paramiko
HERE = os.path.dirname(os.path.abspath(__file__))
TV = os.environ.get('TV_IP', '192.168.1.50')

def connect():
    k = paramiko.RSAKey.from_private_key_file(os.environ.get('TV_KEY') or os.path.join(HERE, '.devkey', 'webos_rsa'), password=os.environ['TV_PASSPHRASE'])
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    # webOS dropbear only accepts the legacy ssh-rsa signature
    c.connect(TV, port=9922, username='prisoner', pkey=k, timeout=10, allow_agent=False, look_for_keys=False,
              disabled_algorithms={'pubkeys': ['rsa-sha2-512', 'rsa-sha2-256']})
    return c

def run(c, cmd, timeout=60):
    i, o, e = c.exec_command(cmd, timeout=timeout)
    return (o.read() + e.read()).decode('utf-8', 'replace').strip()

def main():
    c = connect(); a = sys.argv[1:]
    if a[0] == 'run':
        print(run(c, a[1]))
    elif a[0] == 'install':
        name = os.path.basename(a[1]); remote = '/media/developer/temp/' + name
        run(c, 'mkdir -p /media/developer/temp')
        s = c.open_sftp() if False else None
        # dropbear on webOS has no sftp: stream the file through cat
        i, o, e = c.exec_command(f'cat > {remote}')
        i.write(open(a[1], 'rb').read()); i.channel.shutdown_write(); o.channel.recv_exit_status()
        print(run(c, f'ls -l {remote}'))
        req = json.dumps({'id': 'com.ares.defaultName', 'ipkUrl': remote, 'subscribe': True})
        print(run(c, f"luna-send-pub -i -f luna://com.webos.appInstallService/dev/install '{req}' & sleep 12; kill $! 2>/dev/null", timeout=40))
        run(c, f'rm -f {remote}')
    elif a[0] == 'launch':
        p = json.loads(a[2]) if len(a) > 2 else {}
        req = json.dumps({'id': a[1], 'params': p})
        print(run(c, f"luna-send-pub -n 1 -f luna://com.webos.applicationManager/launch '{req}'"))
    c.close()

if __name__ == '__main__':
    main()
