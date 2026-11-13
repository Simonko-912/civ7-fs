# civ7-fs
A port of the CIV7 FS Exploit for Switch 2 with hopefully higher success rate.
This is basically useless for normal users. Just use the Userland stuff.
FS is basically uneeded for y'all rn.


## How to use?

- use IZCIVSwitch to use the restore_save.py
  <img width="1596" height="517" alt="{CABAC7F4-3984-4729-9DCC-9ADE09700AEE}" src="https://github.com/user-attachments/assets/db0548b1-444d-4c66-865d-792333ae6235" />
    - Do this everytime it fails (i do it every success too just to be save)
- ``node engine/run.cjs 192.168.2.118``
- Works with LDN-only setups: the listener binds the wildcard address and no longer waits on a Wi-Fi/LAN IP, so it comes up inside an LDN room without a normal network. Point the engine at the console's LDN IP.
- Wait potentially up to 10 Minutes
- Profit

# Information

Im too lazy for reddit responses, humour me.  
- Stay on the Home Screen for a minute to 45 Seconds before running the exploit
- Reboot or Turn off your Switch once at least
- Use. LAN. Please. For your girl's sanity at least.
- Use Linux/MacOS (does make it better...)
- Fix the save everytime you get an error via IZCIV
  - ``Ask your LLM how to do this if you struggle to run https://github.com/byizmysh/IZCIVSwitch/blob/main/kit/save-tools/restore_save.py``
    - You can do this instantly after having a failed run e.g. dont restart instantly but run the Restore Save.

# OunceCake-Civ7

`ouncecake/` is a vendored, unmodified copy of
[OunceCake-Civ7](https://github.com/HerXayah/OunceCake-Civ7) (GPL-2.0). It dumps
unencrypted romFS/exeFS for a title by mounting it through `fsp-srv` and pulling files
over FTP, and it runs on top of this repository's engine: give it a run folder.

```
node engine/run.cjs <console-ip>          # get to "held"
cd ouncecake && node ouncecake.cjs /path/to/runs/switch2-<id>
```

See `ouncecake/VENDORED.md` for the artifacts it reads and the one caveat (its FTP
deploy step writes into the mounted game image; listing and reading do not).

# Credits

[Gezine CIV7 XSS](https://github.com/Gezine/CivSwitch/tree/main)  
[CIV7 FS kit](https://gitee.com/mza1010/civswitch-kit)  
[Rastapasta](https://github.com/rastapasta) - For the research and being aweasome and cool and enduring my rantings n shit...lol.  

Also frick KaiHen or whatever.
