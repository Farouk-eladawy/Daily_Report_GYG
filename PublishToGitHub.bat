@echo off
cd /d "%~dp0"

echo ==================================================
echo    Push GYG Sync System to GitHub Actions
echo ==================================================

set REPO_URL=https://github.com/Farouk-eladawy/Daily_Report_GYG.git

:: Check if git is initialized
if not exist ".git" (
    echo [INFO] Initializing new git repository...
    git init
    git branch -M main
    git remote add origin %REPO_URL%
)

:: Ensure origin is correct
git remote set-url origin %REPO_URL%

:: Add all changes
git add .

:: Prompt for commit message
set /p COMMIT_MSG="Enter commit message (or press enter for 'Update sync files'): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=Update sync files

git commit -m "%COMMIT_MSG%"

echo [INFO] Pushing to GitHub...
git push -u origin main

if errorlevel 1 (
    echo [ERROR] Push failed! You might need to pull first if there are remote changes.
    set /p PULL_CONFIRM="Do you want to pull remote changes and try pushing again? (Y/N): "
    if /I "%PULL_CONFIRM%"=="Y" (
        git pull origin main --rebase
        git push origin main
    )
) else (
    echo [SUCCESS] Successfully pushed to GitHub. The Workflow should start automatically or you can trigger it from the Actions tab.
)

pause
