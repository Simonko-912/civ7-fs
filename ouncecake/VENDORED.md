# OunceCake-Civ7, vendored

Third-party tool, unmodified: **OunceCake-Civ7** by its authors (`ozdumptool`), GPL-2.0,
see `LICENSE` and `README.md` in this folder. It dumps unencrypted romFS/exeFS for
Switch 2 titles by mounting the game through `fsp-srv` and pulling files over FTP.

It is vendored here because it runs **on top of this repository's engine**: point it at
one of our run directories and it drives the same retained endpoint and the same copied
engine modules.

## Usage

1. Get a run to `held` with this repo's runner:

   ```
   node engine/run.cjs <console-ip>
   ```

2. Point OunceCake at that run folder:

   ```
   cd ouncecake
   node ouncecake.cjs /path/to/repo/runs/switch2-<id>
   ```

3. Pick a title. It enumerates the base program partitions (`/base/program/0/...`), the
   update layer (`/updates/<version>/program/...`) and, if present, DLC.

The runner writes the artifacts OunceCake reads:

```
runs/switch2-<id>/connection.json              retained endpoint + token + addresses
runs/switch2-<id>/shared/target.json           canonical profile
runs/switch2-<id>/shared/target.civ7.json      per-target profile name OunceCake reads
runs/switch2-<id>/shared/sdk-functions.json    SDK function table
runs/switch2-<id>/shared/                     the engine copy it loads (app/, switch2/, lib/)
```

If you point it at a run created **before** `shared/target.<name>.json` was materialized,
either use a newer run or export the profile explicitly:

```
NS2_TARGET=civ7 NS2_TARGET_ROOT=/path/to/runs/switch2-<id> node ouncecake.cjs /path/to/runs/switch2-<id>
```

## Scope

Reading and listing partitions is read-only. Once it starts the Civ7 FTP server, its
deploy path writes into the mounted game image — that is OunceCake's own behaviour, not
part of the FS-exploit work in this repository, and it is your call and your console.
